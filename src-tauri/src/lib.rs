//! TMMD（透明MD） · 极速本地 Markdown 阅读器（Tauri 2，纯阅读，无工作台）

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const MAX_FILES: usize = 5000;
const MAX_DEPTH: usize = 12;
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const ROOTS_FILE: &str = "roots.json";
const WINDOW_FILE: &str = "window.json";
/// 窗口自适应:默认尺寸 = 工作区 88%(逻辑像素),下限 720×520
const WIN_FRACTION: f64 = 0.88;
const WIN_FLOOR_W: f64 = 720.0;
const WIN_FLOOR_H: f64 = 520.0;
/// 几何落盘去抖:拖拽/缩放停下 500ms 后只写一次盘
const WIN_SAVE_DEBOUNCE: Duration = Duration::from_millis(500);
/// 外部文件变更去抖:一次保存常触发多个事件,静默 300ms 后才发一次
const FS_DEBOUNCE: Duration = Duration::from_millis(300);
const SEARCH_LIMIT_DEFAULT: usize = 200;
const SEARCH_TEXT_MAX: usize = 300;
/// 单文件最多返回多少条命中(库级搜索排序用:防一个文件刷满整屏)
const SEARCH_PER_FILE: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    pub is_desktop: bool,
    pub version: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFolder {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    /// Relative path from root (posix-ish `/`)
    pub path: String,
    #[serde(rename = "type")]
    pub node_type: String,
    /// File mtime as unix ms (dirs omit / 0)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root_name: String,
    pub tree: Vec<TreeNode>,
    pub flat: Vec<FlatEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlatEntry {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootMeta {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// 文档扩展名(唯一真源):2026-10-25 统一。此前 is_doc 列了 .mdx/.html/.htm,而
/// open_path/save_path 只认 .md/.markdown —— 于是"树里有、点开报错""库里能改、库外打不开"。
/// 现在树、打开、保存、写回全部走同一份清单。
const DOC_EXTS: [&str; 5] = ["md", "markdown", "mdx", "html", "htm"];
/// 显式打开额外放行的纯文本:用户自己挑的文件(对话框 / 拖入 / 文件关联)允许 .txt。
const TEXT_EXTS: [&str; 1] = ["txt"];

fn ext_of(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_doc(name: &str) -> bool {
    DOC_EXTS.contains(&ext_of(Path::new(name)).as_str())
}

/// 能否打开/保存:文档族 + 纯文本族。
fn is_openable(p: &Path) -> bool {
    let e = ext_of(p);
    DOC_EXTS.contains(&e.as_str()) || TEXT_EXTS.contains(&e.as_str())
}

/// 给用户的扩展名提示(与 is_openable 同源,不会说一套做一套)。
fn ext_hint() -> String {
    DOC_EXTS
        .iter()
        .chain(TEXT_EXTS.iter())
        .map(|e| format!(".{e}"))
        .collect::<Vec<_>>()
        .join(" / ")
}

fn skip_dir_name(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | ".svn" | ".hg" | "__pycache__" | ".venv" | "venv" | "target" | "dist" | ".next"
    )
}

fn file_mtime_ms(path: &Path) -> Option<u64> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let dur = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(dur.as_millis() as u64)
}

/// Files first by mtime desc (then name); dirs after by name.
fn sort_tree_nodes(nodes: &mut [TreeNode]) {
    nodes.sort_by(|a, b| {
        let af = a.node_type == "file";
        let bf = b.node_type == "file";
        match (af, bf) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (true, true) => {
                let am = a.mtime.unwrap_or(0);
                let bm = b.mtime.unwrap_or(0);
                bm.cmp(&am).then_with(|| a.name.cmp(&b.name))
            }
            (false, false) => a.name.cmp(&b.name),
        }
    });
    for n in nodes.iter_mut() {
        if let Some(ch) = n.children.as_mut() {
            sort_tree_nodes(ch);
        }
    }
}

/// 起控制台子进程的铁律:**一律 CREATE_NO_WINDOW**。
/// `reg`/`cmd`/`powershell` 都是控制台程序,由 GUI 进程(本应用)起它们时 Windows 会新建一个
/// **可见的控制台窗口**闪一下 —— 那正是用户嘴里"疯狂弹我主屏幕"的一类源头(2026-10-25 定位)。
/// 这是产品缺陷,不是"环境问题":任何起控制台子进程的地方都必须走这个函数。
fn hidden_cmd(program: &str) -> std::process::Command {
    let mut c = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Win32 API 只认 NUL 结尾的 UTF-16:`ShellExecuteW` 这类调用拿它当参数,
/// 而不是像 `cmd /C start` 那样把路径塞进一条会被二次解析的命令行(审计 D-04)。
#[cfg(target_os = "windows")]
fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 配置目录(roots.json / window.json / update_state.json / updates/ 都住这里)。
/// **测试缝**:`TMMD_CONFIG_DIR` 覆盖之 —— 自动化起隔离实例时用,保证绝不碰用户真实配置
/// (此前 e2e 只能蹭用户真实 app_config_dir,roots.json/window.json 都有被改的风险)。
fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(d) = std::env::var("TMMD_CONFIG_DIR") {
        if !d.trim().is_empty() {
            let p = PathBuf::from(d);
            fs::create_dir_all(&p).map_err(|e| format!("create test config dir: {e}"))?;
            return Ok(p);
        }
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    Ok(dir)
}

/// 配置目录里的一个文件对象(目录不存在则先建)。
fn config_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(name))
}

fn roots_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    config_path(app, ROOTS_FILE)
}

/// 进程内 AppHandle 单例(setup 注入):让契约里的「零参/仅业务参」命令也能拿到 app
/// (配置目录、事件发射)。单实例单窗口,进程生命周期内恒定,OnceLock 足够。
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

fn app_handle() -> Result<tauri::AppHandle, String> {
    APP_HANDLE
        .get()
        .cloned()
        .ok_or_else(|| "应用句柄尚未初始化".to_string())
}

/// 窗口几何(window.json)。
/// **v2(2026-10-25)起 x/y/w/h 一律是物理像素**,并带版本号:v=0/1 的老文件按旧语义(逻辑像素、
/// 只在主屏工作区内校验)读,读完自然升级;v>=2 走"按坐标找显示器 + 该显示器物理工作区校验"。
/// 为什么改:老写法存的是 `物理 / 当前缩放`,而还原走 LogicalPosition(乘的是**还原时**的缩放),
/// 跨显示器(225% 主屏 ↔ 200% 副屏)来回一次几何就失真 —— 副屏上存的 965×659 回到主屏直接不 fits,
/// 记忆退化成默认值。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WindowState {
    #[serde(default)]
    pub v: u32,
    pub w: f64,
    pub h: f64,
    pub x: f64,
    pub y: f64,
}

/// 几何落盘去抖槽:事件只更新待写值,后台线程静默 500ms 后才落盘。
#[derive(Default)]
struct WindowSaveState {
    inner: std::sync::Mutex<WindowSaveInner>,
}

#[derive(Default)]
struct WindowSaveInner {
    pending: Option<WindowState>,
    last: Option<Instant>,
}

fn read_window_state(app: &tauri::AppHandle) -> Option<WindowState> {
    let p = config_path(app, WINDOW_FILE).ok()?;
    let raw = fs::read_to_string(p).ok()?;
    let st: WindowState = serde_json::from_str(&raw).ok()?;
    let sane = st.w.is_finite()
        && st.h.is_finite()
        && st.x.is_finite()
        && st.y.is_finite()
        && st.w > 0.0
        && st.h > 0.0;
    sane.then_some(st)
}

fn write_window_state(app: &tauri::AppHandle, st: WindowState) {
    let Ok(p) = config_path(app, WINDOW_FILE) else {
        return;
    };
    if let Ok(raw) = serde_json::to_string(&st) {
        let _ = fs::write(p, raw);
    }
}

/// 当前显示器工作区(**逻辑像素** = 物理 / scale_factor)。
/// 实测(2026-10-24 真机,225% 缩放):Tauri 的 `work_area()` 给的是物理像素、`scale_factor()`
/// 给的是真实缩放(2.25);窗口用 LogicalSize/LogicalPosition 创建 → 二者必须配成逻辑像素,
/// 否则 667 逻辑会被放大成 1500 物理以外的东西(直接出屏)。
/// 拿不到显示器(极端无头场景)退化为 1280×800@1.0。
fn work_area_logical(win: &tauri::WebviewWindow) -> (f64, f64, f64, f64) {
    let mon = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())
        .or_else(|| {
            win.available_monitors()
                .ok()
                .and_then(|v| v.into_iter().next())
        });
    match mon {
        Some(m) => {
            let sf = if m.scale_factor() > 0.0 {
                m.scale_factor()
            } else {
                1.0
            };
            let wa = m.work_area();
            (
                wa.position.x as f64 / sf,
                wa.position.y as f64 / sf,
                wa.size.width as f64 / sf,
                wa.size.height as f64 / sf,
            )
        }
        None => (0.0, 0.0, 1280.0, 800.0),
    }
}

/// 存档矩形是否完整落在工作区内(±2 逻辑像素容差,兼容贴边吸附)。
fn window_state_fits(st: &WindowState, wx: f64, wy: f64, ww: f64, wh: f64) -> bool {
    const EPS: f64 = 2.0;
    if st.w < 320.0 || st.h < 240.0 {
        return false;
    }
    if st.w > ww + EPS || st.h > wh + EPS {
        return false;
    }
    if st.x < wx - EPS || st.y < wy - EPS {
        return false;
    }
    st.x + st.w <= wx + ww + EPS && st.y + st.h <= wy + wh + EPS
}

/// 默认几何:工作区 88%,下限 720×520(工作区本身更窄/更矮时取工作区),居中。
fn default_window_state(wx: f64, wy: f64, ww: f64, wh: f64) -> WindowState {
    let w = (ww * WIN_FRACTION).clamp(WIN_FLOOR_W.min(ww), ww);
    let h = (wh * WIN_FRACTION).clamp(WIN_FLOOR_H.min(wh), wh);
    WindowState {
        v: 0, // 默认值本身按逻辑像素立即落地,不需要 v2 语义
        w,
        h,
        x: wx + (ww - w) / 2.0,
        y: wy + (wh - h) / 2.0,
    }
}

/// 包含该物理点的显示器(找不到 None):v2 几何靠它决定"上次那块屏还在不在"。
fn monitor_at(win: &tauri::WebviewWindow, x: i32, y: i32) -> Option<tauri::Monitor> {
    win.available_monitors()
        .ok()?
        .into_iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
        })
}

/// 物理像素下"完整落在该显示器工作区"(±2px 容差,兼容贴边吸附)。
fn state_fits_physical(st: &WindowState, wx: i32, wy: i32, ww: u32, wh: u32) -> bool {
    const EPS: f64 = 2.0;
    if st.w < 320.0 || st.h < 240.0 {
        return false;
    }
    let (wx, wy, ww, wh) = (wx as f64, wy as f64, ww as f64, wh as f64);
    if st.w > ww + EPS || st.h > wh + EPS {
        return false;
    }
    if st.x < wx - EPS || st.y < wy - EPS {
        return false;
    }
    st.x + st.w <= wx + ww + EPS && st.y + st.h <= wy + wh + EPS
}

/// 启动:还原上次几何。v2 用物理坐标 + "落在哪块屏就用哪块屏的工作区"校验(副屏也能原样还原);
/// 老文件(v<2)沿用逻辑像素 + 主屏工作区校验。
/// **调用方负责随后 show()** —— 窗口现在以 visible:false 创建,就是为了先摆好位置再露面,
/// 免得用户主屏上闪一下再跳走(2026-10-25 用户当场投诉的那一下)。
fn apply_initial_window(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let saved = read_window_state(app);
    if let Some(s) = saved {
        if s.v >= 2 {
            if let Some(m) = monitor_at(&win, s.x as i32, s.y as i32) {
                let wa = m.work_area();
                if state_fits_physical(&s, wa.position.x, wa.position.y, wa.size.width, wa.size.height) {
                    let _ = win.set_size(tauri::PhysicalSize::new(s.w, s.h));
                    let _ = win.set_position(tauri::PhysicalPosition::new(s.x, s.y));
                    return;
                }
            }
            // 上次那块屏不在/放不下:落到主屏默认
            let (wx, wy, ww, wh) = work_area_logical(&win);
            let d = default_window_state(wx, wy, ww, wh);
            let _ = win.set_size(tauri::LogicalSize::new(d.w, d.h));
            let _ = win.set_position(tauri::LogicalPosition::new(d.x, d.y));
            return;
        }
    }
    let (wx, wy, ww, wh) = work_area_logical(&win);
    let st = match saved {
        Some(s) if window_state_fits(&s, wx, wy, ww, wh) => s, // 老语义:逻辑像素
        _ => default_window_state(wx, wy, ww, wh),
    };
    let _ = win.set_size(tauri::LogicalSize::new(st.w, st.h));
    let _ = win.set_position(tauri::LogicalPosition::new(st.x, st.y));
}

/// 归一化当前几何为**物理像素**(v2;最大化/最小化/全屏期间返回 None,
/// 那些尺寸不是用户意图,存了会污染下次启动)。
fn current_window_state(win: &tauri::Window) -> Option<WindowState> {
    if win.is_maximized().unwrap_or(false)
        || win.is_minimized().unwrap_or(false)
        || win.is_fullscreen().unwrap_or(false)
    {
        return None;
    }
    let size = win.inner_size().ok()?;
    let pos = win.outer_position().ok()?;
    Some(WindowState {
        v: 2,
        w: size.width as f64,
        h: size.height as f64,
        x: pos.x as f64,
        y: pos.y as f64,
    })
}

/// Resized/Moved 入口:只更新待写值 + 时间戳,写盘交给后台线程去抖(拖拽过程零写盘)。
fn queue_window_save(win: &tauri::Window, app: &tauri::AppHandle) {
    let Some(st) = current_window_state(win) else {
        return;
    };
    let Some(state) = app.try_state::<WindowSaveState>() else {
        return;
    };
    {
        let mut g = match state.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        g.pending = Some(st);
        g.last = Some(Instant::now());
    }
}

/// 关窗等退出路径:立即落盘,不吃去抖延迟。
fn flush_window_save(win: &tauri::Window, app: &tauri::AppHandle) {
    let Some(st) = current_window_state(win) else {
        return;
    };
    if let Some(state) = app.try_state::<WindowSaveState>() {
        match state.inner.lock() {
            Ok(mut g) => {
                g.pending = None;
                g.last = None;
            }
            Err(_) => {}
        }
    }
    write_window_state(app, st);
}

/// 后台落盘线程:200ms 轮询,几何静默 ≥500ms 才写一次盘。
fn spawn_window_save_worker(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(200));
        let due = match app.try_state::<WindowSaveState>() {
            Some(state) => match state.inner.lock() {
                Ok(mut g) => match (g.pending, g.last) {
                    (Some(st), Some(last)) if last.elapsed() >= WIN_SAVE_DEBOUNCE => {
                        g.pending = None;
                        g.last = None;
                        Some(st)
                    }
                    _ => None,
                },
                Err(_) => None,
            },
            None => None,
        };
        if let Some(st) = due {
            write_window_state(&app, st);
        }
    });
}

/// Reject `..` and absolute segments in relative path.
fn sanitize_rel(rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    let mut out = PathBuf::new();
    for part in rel.split('/').filter(|s| !s.is_empty()) {
        if part == "." {
            continue;
        }
        if part == ".." {
            return Err("路径非法：含 ..".into());
        }
        if part.contains(':') {
            return Err("路径非法".into());
        }
        out.push(part);
    }
    Ok(out)
}

/// Normalize for cage compare: strip Windows `\\?\` / `//?/` prefix, lower-case on Windows.
fn cage_key(p: &Path) -> String {
    let mut s = p.to_string_lossy().replace('/', "\\");
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        s = rest.to_string();
    } else if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.replace('/', "\\");
    }
    #[cfg(windows)]
    {
        s = s.to_ascii_lowercase();
    }
    // Ensure trailing separator does not break prefix checks inconsistently
    while s.ends_with('\\') && s.len() > 3 {
        s.pop();
    }
    s
}

fn is_under_root(root_can: &Path, full: &Path) -> bool {
    let r = cage_key(root_can);
    let f = cage_key(full);
    if f == r {
        return true;
    }
    let prefix = if r.ends_with('\\') {
        r.clone()
    } else {
        format!("{r}\\")
    };
    f.starts_with(&prefix)
}

/// 路径自身是不是 NTFS 重解析点(junction / 目录联接 / symlink)?
/// 文本前缀比较与 `\\?\` 前缀都看不出这一点:`root\link\x.md` 的字面在根内,
/// 真身可能在 `C:\Windows`(审计 D-06)。
#[cfg(windows)]
fn is_reparse_point(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    fs::symlink_metadata(p)
        .map(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_reparse_point(p: &Path) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// 把(可能尚不存在的)目标解析到"最近一个存在的祖先"真身上,再拼回剩下的段。
/// 存在的祖先一律 `canonicalize`:junction / symlink 只能靠真身解析暴露,
/// 而 cage 的"文本前缀在根内"对它们完全无效(审计 D-06)。
fn resolve_nearest(p: &Path) -> Result<PathBuf, String> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = if p.as_os_str().is_empty() {
        std::env::current_dir().map_err(|e| format!("无法解析路径: {e}"))?
    } else {
        p.to_path_buf()
    };
    loop {
        if cur.exists() {
            let mut base = cur.canonicalize().map_err(|e| format!("无法解析路径: {e}"))?;
            for part in tail.iter().rev() {
                base.push(part);
            }
            return Ok(base);
        }
        let name = match cur.file_name() {
            Some(n) => n.to_os_string(),
            None => return Err("无法解析路径".into()),
        };
        let par = match cur.parent() {
            Some(par) if !par.as_os_str().is_empty() => par.to_path_buf(),
            // 相对路径(父目录是空串)按当前目录展开,否则会一路走空
            _ => std::env::current_dir().map_err(|e| format!("无法解析路径: {e}"))?,
        };
        tail.push(name);
        cur = par;
    }
}

fn cage_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root_can = root
        .canonicalize()
        .map_err(|e| format!("无法解析根目录: {e}"))?;
    let rel_pb = sanitize_rel(rel)?;
    // 逐段拒绝重解析点:根内一旦有 junction / symlink,后面所有"在根内"的判断都不作数
    let mut walk = root_can.clone();
    for comp in rel_pb.components() {
        walk.push(comp.as_os_str());
        if is_reparse_point(&walk) {
            return Err("路径越界".into());
        }
    }
    let joined = root_can.join(&rel_pb);
    let full = if joined.exists() {
        joined
            .canonicalize()
            .map_err(|e| format!("无法解析路径: {e}"))?
    } else {
        // 尚不存在:先把**父目录**解析成真身再拼末段。旧写法直接用文本拼接结果,
        // 于是 `root\link\新文件.md` 能通过前缀检查、实际写到根外面去(审计 D-06)。
        resolve_nearest(&joined)?
    };
    if !is_under_root(&root_can, &full) {
        // 只留可映射的前缀:中文解释放 i18n 字典里,否则 EN/JA 界面会出现"英文前缀 + 中文后半句"
        return Err("路径越界".into());
    }
    Ok(full)
}

fn rel_posix(root: &Path, full: &Path) -> String {
    full.strip_prefix(root)
        .map(|p| {
            p.components()
                .map(|c| match c {
                    Component::Normal(s) => s.to_string_lossy().into_owned(),
                    _ => String::new(),
                })
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

#[tauri::command]
fn desktop_info() -> DesktopInfo {
    DesktopInfo {
        is_desktop: true,
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
    }
}

#[tauri::command]
fn pick_folder() -> Result<Option<PickedFolder>, String> {
    let folder = rfd::FileDialog::new()
        .set_title(t(Msg::PickFolderTitle))
        .pick_folder();
    Ok(folder.map(|p| {
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.to_string_lossy().into_owned());
        PickedFolder {
            path: p.to_string_lossy().into_owned(),
            name,
        }
    }))
}

#[tauri::command]
fn list_md_tree(root: String) -> Result<ScanResult, String> {
    let root_pb = PathBuf::from(&root);
    if !root_pb.is_dir() {
        return Err(format!("不是目录: {root}"));
    }
    let root_can = root_pb
        .canonicalize()
        .map_err(|e| format!("canonicalize root: {e}"))?;
    let root_name = root_can
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "folder".into());

    let mut flat: Vec<FlatEntry> = Vec::new();
    let mut file_count = 0usize;

    // Build tree via recursive walk limited
    fn walk(
        dir: &Path,
        root_can: &Path,
        depth: usize,
        flat: &mut Vec<FlatEntry>,
        file_count: &mut usize,
    ) -> Result<Vec<TreeNode>, String> {
        if depth > MAX_DEPTH || *file_count >= MAX_FILES {
            return Ok(vec![]);
        }
        let mut nodes: Vec<TreeNode> = Vec::new();
        let rd = fs::read_dir(dir).map_err(|e| format!("read_dir: {e}"))?;
        let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());

        for ent in entries {
            if *file_count >= MAX_FILES {
                break;
            }
            let name = ent.file_name().to_string_lossy().into_owned();
            let ft = ent.file_type().map_err(|e| e.to_string())?;
            let full = ent.path();
            if ft.is_dir() {
                if skip_dir_name(&name) {
                    continue;
                }
                let children = walk(&full, root_can, depth + 1, flat, file_count)?;
                if children.is_empty() {
                    continue;
                }
                let rel = rel_posix(root_can, &full);
                nodes.push(TreeNode {
                    name,
                    path: rel,
                    node_type: "dir".into(),
                    mtime: None,
                    children: Some(children),
                });
            } else if ft.is_file() {
                if !is_doc(&name) {
                    continue;
                }
                *file_count += 1;
                let rel = rel_posix(root_can, &full);
                let mtime = file_mtime_ms(&full);
                flat.push(FlatEntry {
                    path: rel.clone(),
                    name: name.clone(),
                    entry_type: "file".into(),
                    mtime,
                });
                nodes.push(TreeNode {
                    name,
                    path: rel,
                    node_type: "file".into(),
                    mtime,
                    children: None,
                });
            }
        }
        // also fill dir nodes created above — mtime unused for dirs
        // sort after full sibling collect
        sort_tree_nodes(&mut nodes);
        Ok(nodes)
    }

    let mut tree = walk(&root_can, &root_can, 0, &mut flat, &mut file_count)?;
    sort_tree_nodes(&mut tree);
    // flat: newest first (matches reader expectation)
    flat.sort_by(|a, b| {
        let am = a.mtime.unwrap_or(0);
        let bm = b.mtime.unwrap_or(0);
        bm.cmp(&am).then_with(|| a.name.cmp(&b.name))
    });
    Ok(ScanResult {
        root_name,
        tree,
        flat,
    })
}

/// 本应用"读出来过"的文件指纹:mtime_ns + size。保存时用来发现"磁盘已被外部改过"。
/// 只记我们自己读过的路径,不扫描全盘;写成功后刷新,避免把自己的写入误判成冲突。
static LAST_READ: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, (u128, u64)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn fingerprint(p: &Path) -> Option<(u128, u64)> {
    let m = fs::metadata(p).ok()?;
    let t = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((t, m.len()))
}

fn remember_read(p: &Path) {
    if let Some(fp) = fingerprint(p) {
        if let Ok(mut m) = LAST_READ.lock() {
            // 键必须用 cage_key 归一化:`\\?\` 前缀 / 大小写 / 分隔符在 read_text(经 cage_join 规范化)
            // 与 open_path(前端原样串)两条路径上不同,否则"对话框打开 → 树里再打开 → 保存"会取不到基线、
            // 冲突检测静默失效(2026-10-25 核验发现)。
            m.insert(cage_key(p), fp);
        }
    }
}

/// 原文件换行风格:编辑器里的 textarea 会把 CRLF 归一成 LF,保存时必须还原,否则"改一个字"
/// 会把整个文件的换行风格改掉(VS Code 同款回归)。
/// BOM / 编码不在这里 —— 那是 FILE_ENCODING 一份真相说了算,两处都决定就会"每存一次多一个 BOM"(审计 B3)。
fn probe_crlf(p: &Path) -> bool {
    if let Ok(bytes) = fs::read(p) {
        let crlf = bytes.windows(2).filter(|w| *w == b"\r\n").count();
        let lf = bytes.iter().filter(|b| **b == b'\n').count();
        return crlf > 0 && crlf * 2 >= lf; // 多数行是 CRLF 就按 CRLF 写回
    }
    false
}

// ───────────────────────── 编码探测与还原(B2 / B3) ─────────────────────────
// 中文 Windows 上大量 .md 是 GB18030,UTF-16 也不少;旧版只认 UTF-8,这些文件**直接打不开**。
// 顺序固定:BOM(UTF-8 / UTF-16LE / UTF-16BE)→ 严格 UTF-8 → GB18030 → lossy 兜底。
// 读出来剥掉前导 BOM,写回去按**探测到的那一种编码 + 同样的 BOM 状态**还原。

/// 文本文件的编码(唯一真源):读的时候探测一次,写回时必须用它。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Gb18030,
}

/// 读过 / 写过的文件的编码。键与 LAST_READ 同一套 `cage_key` 归一化,
/// 否则"树里读、对话框存"两条路径会对不上,保存就还原不回原编码。
static FILE_ENCODING: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, TextEncoding>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn remember_encoding(p: &Path, enc: TextEncoding) {
    if let Ok(mut m) = FILE_ENCODING.lock() {
        m.insert(cage_key(p), enc);
    }
}

fn known_encoding(p: &Path) -> Option<TextEncoding> {
    FILE_ENCODING
        .lock()
        .ok()
        .and_then(|m| m.get(&cage_key(p)).copied())
}

/// 没读过(或读失败)时的兜底:直接看盘上的字节判 BOM / 编码。
fn encoding_from_disk(p: &Path) -> TextEncoding {
    fs::read(p)
        .map(|b| decode_bytes(&b).1)
        .unwrap_or(TextEncoding::Utf8)
}

/// 剥内容里的前导 BOM。读出后必须先剥(否则前端渲染成 `\uFEFF# Head`,首标题不成立),
/// 写回时只由编码本身决定补不补 —— 否则每存一次多一个 BOM,文件逐步损坏(审计 B3)。
fn strip_leading_bom(mut s: String) -> String {
    if s.starts_with('\u{feff}') {
        s.remove(0);
    }
    s
}

/// UTF-16 字节流 → String(`le` = 小端)。不合法代理对按替换字符处理,不整篇失败。
fn decode_utf16(bytes: &[u8], le: bool) -> String {
    let n = bytes.len() / 2;
    let mut units: Vec<u16> = Vec::with_capacity(n + 1);
    for i in 0..n {
        let b = [bytes[i * 2], bytes[i * 2 + 1]];
        units.push(if le {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        });
    }
    if bytes.len() % 2 == 1 {
        // 尾部单字节(截断文件):补一个码元,不让整篇变成"解码失败"
        units.push(bytes[bytes.len() - 1] as u16);
    }
    String::from_utf16_lossy(&units)
}

// GB18030 / 系统代码页:Windows 自带 MultiByteToWideChar / WideCharToMultiByte。
// 这里直接声明 kernel32 导出 —— windows-sys 已启用的 feature 里没有 Win32_Globalization,
// 而本工单不允许改 Cargo.toml 加依赖(见交付说明)。
#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn MultiByteToWideChar(
        code_page: u32,
        dw_flags: u32,
        lp_multibyte_str: *const u8,
        cb_multibyte: i32,
        lp_wide_char_str: *mut u16,
        cch_wide_char: i32,
    ) -> i32;
    fn WideCharToMultiByte(
        code_page: u32,
        dw_flags: u32,
        lp_wide_char_str: *const u16,
        cch_wide_char: i32,
        lp_multibyte_str: *mut u8,
        cb_multibyte: i32,
        lp_default_char: *const u8,
        lp_used_default_char: *mut i32,
    ) -> i32;
}

/// 用系统代码页解码。`MB_ERR_INVALID_CHARS` 让"根本不是这个编码"的字节直接失败,
/// 而不是静默产出一篇乱码 —— 失败就走后面的 lossy 兜底。
#[cfg(target_os = "windows")]
fn decode_cp(code_page: u32, bytes: &[u8]) -> Option<String> {
    const MB_ERR_INVALID_CHARS: u32 = 0x0000_0008;
    if bytes.is_empty() {
        return Some(String::new());
    }
    if bytes.len() > i32::MAX as usize {
        return None;
    }
    let len = bytes.len() as i32;
    let need = unsafe {
        MultiByteToWideChar(
            code_page,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            len,
            std::ptr::null_mut(),
            0,
        )
    };
    if need <= 0 {
        return None;
    }
    let mut out: Vec<u16> = vec![0; need as usize];
    let got = unsafe {
        MultiByteToWideChar(
            code_page,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            len,
            out.as_mut_ptr(),
            need,
        )
    };
    if got <= 0 {
        return None;
    }
    out.truncate(got as usize);
    String::from_utf16(&out).ok()
}

#[cfg(not(target_os = "windows"))]
fn decode_cp(_code_page: u32, _bytes: &[u8]) -> Option<String> {
    None
}

/// 把正文编回指定代码页(保存 GB18030 文件时用)。有字符打不出来就返回 None,由调用方兜底。
#[cfg(target_os = "windows")]
fn encode_cp(code_page: u32, text: &str) -> Option<Vec<u8>> {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.is_empty() {
        return Some(Vec::new());
    }
    if units.len() > i32::MAX as usize {
        return None;
    }
    let len = units.len() as i32;
    let need = unsafe {
        WideCharToMultiByte(
            code_page,
            0,
            units.as_ptr(),
            len,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            std::ptr::null_mut(),
        )
    };
    if need <= 0 {
        return None;
    }
    let mut out = vec![0u8; need as usize];
    let got = unsafe {
        WideCharToMultiByte(
            code_page,
            0,
            units.as_ptr(),
            len,
            out.as_mut_ptr(),
            need,
            std::ptr::null(),
            std::ptr::null_mut(),
        )
    };
    if got <= 0 {
        return None;
    }
    out.truncate(got as usize);
    Some(out)
}

#[cfg(not(target_os = "windows"))]
fn encode_cp(_code_page: u32, _text: &str) -> Option<Vec<u8>> {
    None
}

/// 字节 → (文本, 探测到的编码)。文本已剥前导 BOM。
fn decode_bytes(bytes: &[u8]) -> (String, TextEncoding) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let rest = &bytes[3..];
        let text = match std::str::from_utf8(rest) {
            Ok(s) => s.to_string(),
            Err(_) => String::from_utf8_lossy(rest).into_owned(),
        };
        return (strip_leading_bom(text), TextEncoding::Utf8Bom);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let text = decode_utf16(&bytes[2..], true);
        return (strip_leading_bom(text), TextEncoding::Utf16Le);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let text = decode_utf16(&bytes[2..], false);
        return (strip_leading_bom(text), TextEncoding::Utf16Be);
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (strip_leading_bom(s.to_string()), TextEncoding::Utf8);
    }
    // 严格 UTF-8 不成立:中文 Windows 的老文档多半是 GB18030
    if let Some(s) = decode_cp(54936, bytes) {
        return (strip_leading_bom(s), TextEncoding::Gb18030);
    }
    // 兜底:宁可出现替换字符,也不让用户打不开文件
    (
        strip_leading_bom(String::from_utf8_lossy(bytes).into_owned()),
        TextEncoding::Utf8,
    )
}

/// 按"原文件的编码 + 原文件的 BOM 状态"把正文编回字节。
/// GB18030 走系统编码表;真有字符编不回去时退回 UTF-8 —— 宁可编码变了,也绝不写坏 / 写丢正文。
fn encode_text(body: &str, enc: TextEncoding) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(body.len() + 3);
    match enc {
        TextEncoding::Utf8 => out.extend_from_slice(body.as_bytes()),
        TextEncoding::Utf8Bom => {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(body.as_bytes());
        }
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            let le = enc == TextEncoding::Utf16Le;
            if le {
                out.extend_from_slice(&[0xFF, 0xFE]);
            } else {
                out.extend_from_slice(&[0xFE, 0xFF]);
            }
            for u in body.encode_utf16() {
                let b = if le { u.to_le_bytes() } else { u.to_be_bytes() };
                out.extend_from_slice(&b);
            }
        }
        TextEncoding::Gb18030 => match encode_cp(54936, body) {
            Some(b) => return b,
            None => out.extend_from_slice(body.as_bytes()),
        },
    }
    out
}

/// 静默补基线:把盘上的"当前真身"读一遍(解出编码 + 记指纹),失败就什么都不记。
/// 只为一件事:让保存路径上的冲突检测在"另存为 / 拖拽 / 从没读过"这些情况下也有基线可依(审计 B4)。
fn prime_baseline(p: &Path) -> bool {
    let Ok(bytes) = fs::read(p) else {
        return false;
    };
    let (_text, enc) = decode_bytes(&bytes);
    remember_encoding(p, enc);
    remember_read(p);
    true
}

/// 原子写:同目录临时文件 → sync → rename 覆盖。中途失败(崩溃/断电/杀进程)不会留下
/// 半截正文,原文件保持不动。失败清理临时文件。
fn write_atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = p.parent().ok_or_else(|| "无父目录".to_string())?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "doc".into());
    let tmp = dir.join(format!(".{name}.tmmd-tmp"));
    // 先清上次失败留下的残件(只读/被占时下面会给出可读错误),避免此后每次保存都卡在同一处
    let _ = fs::remove_file(&tmp);
    if let Err(e) = fs::write(&tmp, bytes) {
        let _ = fs::remove_file(&tmp); // create 成功但 write_all 失败(如 ENOSPC)也要清
        return Err(format!("写临时文件失败({}): {e}", tmp.display()));
    }
    if let Ok(f) = fs::File::open(&tmp) {
        let _ = f.sync_all();
    }
    if let Err(e) = fs::rename(&tmp, p) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换文件失败: {e}"));
    }
    Ok(())
}

/// 保存统一收尾:冲突检测(force=false 时对比读入指纹;基线缺失先补一次,补不上按冲突返回)
/// → 按原编码 + 原 BOM 状态还原换行/编码 → 原子写 → 刷新指纹。
/// 冲突以 `CONFLICT|<path>` 返回给前端,由前端决定覆盖 / 另存 / 取消(不静默覆盖)。
fn save_guarded(path: &Path, content: &str, force: bool) -> Result<(), String> {
    if !is_openable(path) {
        return Err(format!("仅支持 {} 文件", ext_hint()));
    }
    let key = cage_key(path);   // 与 remember_read 同一套归一化,否则键对不上 = 冲突检测静默失效
    if !force {
        // 基线缺口(B4):除 read_text/open_path 之外(另存为、拖拽、外部改过)没有基线时,
        // 旧写法直接放行 = 把用户在别的编辑器里的改动静默覆盖。这里先补一次基线(读一遍盘);
        // 补不上就不写,按既有 `CONFLICT|<path>` 协议交给前端确认(前端已有 force 通道)。
        let has_base = LAST_READ
            .lock()
            .map(|m| m.contains_key(&key))
            .unwrap_or(false);
        if !has_base && path.is_file() {
            prime_baseline(path);
        }
        let known = LAST_READ.lock().ok().and_then(|m| m.get(&key).copied());
        match (known, fingerprint(path)) {
            (Some(k), Some(now)) => {
                if k != now {
                    return Err(format!("CONFLICT|{key}"));
                }
            }
            // 目标在、基线却建立不起来(读不出 / 没权限):宁可不写,也不静默覆盖
            (None, Some(_)) => return Err(format!("CONFLICT|{key}")),
            _ => {}
        }
    }
    // 编码 + BOM 一律按"原文件是什么"还原;UTF-16 的换行只能从解码后的文本里数
    let enc = known_encoding(path).unwrap_or_else(|| encoding_from_disk(path));
    let crlf = if matches!(enc, TextEncoding::Utf16Le | TextEncoding::Utf16Be) {
        fs::read(path)
            .map(|b| {
                let (text, _) = decode_bytes(&b);
                let c = text.matches("\r\n").count();
                let l = text.matches('\n').count();
                c > 0 && c * 2 >= l
            })
            .unwrap_or(false)
    } else {
        probe_crlf(path)
    };
    let lf = content.replace("\r\n", "\n");
    let body = if crlf { lf.replace('\n', "\r\n") } else { lf };
    // 先剥正文里的前导 BOM:补不补只由 enc 决定,两处都补就是"每存一次多一个 BOM"
    let body = strip_leading_bom(body);
    let bytes = encode_text(&body, enc);
    write_atomic(path, &bytes)?;
    remember_encoding(path, enc);
    if let Ok(mut m) = LAST_READ.lock() {
        if let Some(fp) = fingerprint(path) {
            m.insert(key, fp);
        }
    }
    Ok(())
}

/// 新建文件(囚笼内)。目标已存在则拒绝,避免手滑覆盖;父目录不存在时按需创建。
#[tauri::command]
fn create_file(root: String, rel: String, content: Option<String>) -> Result<(), String> {
    let root_pb = PathBuf::from(&root);
    let full = cage_join(&root_pb, &rel)?;
    if full.exists() {
        return Err(format!("已存在同名文件: {rel}"));
    }
    if let Some(dir) = full.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let body = content.unwrap_or_default();
    write_atomic(&full, body.as_bytes())?;
    remember_encoding(&full, TextEncoding::Utf8); // 新建文件就是无 BOM 的 UTF-8,保存时按它还原
    remember_read(&full);
    Ok(())
}

/// 重命名 / 移动(囚笼内):新旧路径都必须落在同一 root 内,目标已存在则拒绝(不静默覆盖)。
#[tauri::command]
fn rename_file(root: String, rel: String, new_rel: String) -> Result<(), String> {
    let root_pb = PathBuf::from(&root);
    let from = cage_join(&root_pb, &rel)?;
    let to = cage_join(&root_pb, &new_rel)?;
    if !from.is_file() {
        return Err(format!("源文件不存在: {rel}"));
    }
    if to.exists() {
        return Err(format!("目标已存在: {new_rel}"));
    }
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    fs::rename(&from, &to).map_err(|e| format!("重命名失败: {e}"))?;
    if let Ok(mut m) = LAST_READ.lock() {
        m.remove(&cage_key(&from));
    }
    remember_read(&to);
    Ok(())
}

/// 删除(囚笼内):**移入系统回收站**,不做永久删除 —— 阅读器里误点一下不该变成数据事故。
#[cfg(target_os = "windows")]
fn recycle(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFileOperationW, SHFILEOPSTRUCTW,
    };
    // cage_join 给的是 canonicalize 过的 `\\?\C:\...`;SHFileOperation 不认扩展长度前缀
    // (实测直接返回错误码 124),必须先剥掉 —— UNC 的 `\\?\UNC\` 还原成 `\\`。
    let mut shown = path.to_string_lossy().replace('/', "\\");
    if let Some(rest) = shown.strip_prefix(r"\\?\UNC\") {
        shown = format!(r"\\{rest}");
    } else if let Some(rest) = shown.strip_prefix(r"\\?\") {
        shown = rest.to_string();
    }
    let mut from: Vec<u16> = std::ffi::OsStr::new(&shown).encode_wide().collect();
    from.push(0);
    from.push(0); // pFrom 需要双 nul 结尾
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE as u32;
    op.pFrom = from.as_ptr();
    op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16;
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc != 0 {
        return Err(format!("移入回收站失败: code={rc}, path={shown}"));
    }
    if op.fAnyOperationsAborted != 0 {
        return Err("移入回收站被中断".into());
    }
    Ok(())
}

#[tauri::command]
fn delete_file(root: String, rel: String) -> Result<(), String> {
    let root_pb = PathBuf::from(&root);
    let full = cage_join(&root_pb, &rel)?;
    if !full.is_file() {
        return Err(format!("不是文件: {rel}"));
    }
    #[cfg(target_os = "windows")]
    {
        recycle(&full)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        return Err("当前平台未实现回收站删除".into());
    }
    if let Ok(mut m) = LAST_READ.lock() {
        m.remove(&cage_key(&full));
    }
    Ok(())
}

/// 另存为:弹系统保存对话框,只回路径(内容由前端随后调 save_path 写)。
/// 放在后端是为了拿到原生对话框与扩展名过滤器,并让"用户自己选的目标"这一语义与 save_path 对齐。
#[tauri::command]
fn pick_save(default_name: Option<String>) -> Result<Option<String>, String> {
    let mut dlg = rfd::FileDialog::new()
        .add_filter("Markdown / Text", &["md", "markdown", "mdx", "txt", "html", "htm"])
        .set_file_name(default_name.unwrap_or_else(|| format!("{}.md", t(Msg::UntitledBase))));
    if let Some(dir) = default_dir() {
        dlg = dlg.set_directory(dir);
    }
    Ok(dlg.save_file().map(|p| p.to_string_lossy().to_string()))
}

/// 保存对话框的起始目录:优先当前文档所在目录(由前端通过环境变量式的临时文件传递太重,这里用 cwd 兜底)。
fn default_dir() -> Option<PathBuf> {
    std::env::current_dir().ok()
}

/// 写回文件(文件夹浏览模式):囚笼内校验 + 大小上限 + 原子写,与 read_text 对称。
/// force=true 跳过冲突检测(前端已确认覆盖)。
#[tauri::command]
fn write_text(root: String, rel: String, content: String, force: Option<bool>) -> Result<(), String> {
    if content.len() as u64 > MAX_BYTES {
        return Err(format!("内容过大(超过 {}MB)", MAX_BYTES / 1024 / 1024));
    }
    let root_pb = PathBuf::from(&root);
    let full = cage_join(&root_pb, &rel)?;
    save_guarded(&full, &content, force.unwrap_or(false))
}

/// 写回单文件(双击/拖拽模式):与 open_path 同一份扩展名清单 + 原子写 + 冲突检测。
#[tauri::command]
fn save_path(path: String, content: String, force: Option<bool>) -> Result<(), String> {
    if content.len() as u64 > MAX_BYTES {
        return Err(format!("内容过大(超过 {}MB)", MAX_BYTES / 1024 / 1024));
    }
    // 目标可能还不存在:先解析到最近存在的祖先真身再写(B5),
    // 否则经 junction / symlink 的"路径在别处"完全看不出来(审计 D-05/D-06)。
    let p = resolve_nearest(Path::new(&path))?;
    save_guarded(&p, &content, force.unwrap_or(false))
}

/// 关窗守卫:前端拿数据安全当命,关窗前必须先问过它。
/// 未放行时 CloseRequested 只发 `close-requested` 事件、不真关;前端处理完(该存的存了)
/// 再调 `allow_close` 放行 —— 这样"点 X 丢未保存内容"这条路彻底堵死。
static CLOSE_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn allow_close(app: tauri::AppHandle) -> Result<(), String> {
    let Some(w) = app.get_webview_window("main") else {
        return Err("找不到主窗口".into());
    };
    CLOSE_OK.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Err(e) = w.close() {
        // 没关成就复位:否则守卫会永久失效,以后每次关窗都静默放走(将来加第二窗口/托盘就是数据事故)
        CLOSE_OK.store(false, std::sync::atomic::Ordering::SeqCst);
        return Err(format!("关窗失败: {e}"));
    }
    Ok(())
}

#[tauri::command]
fn read_text(root: String, rel: String) -> Result<String, String> {
    let root_pb = PathBuf::from(&root);
    let full = cage_join(&root_pb, &rel)?;
    if !full.is_file() {
        return Err(format!("不是文件: {}", full.display()));
    }
    let meta = fs::metadata(&full).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "文件过大（>{}MB）",
            MAX_BYTES / 1024 / 1024
        ));
    }
    // 不再 `read_to_string`:GB18030 / UTF-16 的中文文档要能打开,且读出来必须已剥 BOM(否则首标题不成立)
    let bytes = fs::read(&full).map_err(|e| format!("读文件失败: {e}"))?;
    let (md, enc) = decode_bytes(&bytes);
    remember_encoding(&full, enc); // 记编码:保存时按同一种编码 + 同样的 BOM 状态写回
    remember_read(&full); // 记指纹:保存时用来发现"外部已改"
    Ok(md)
}

#[tauri::command]
fn load_roots(app: tauri::AppHandle) -> Result<Vec<RootMeta>, String> {
    read_roots(&app)
}

/// roots.json 读取(命令与全文搜索共用):顺手丢掉已消失的根。
fn read_roots(app: &tauri::AppHandle) -> Result<Vec<RootMeta>, String> {
    let p = roots_path(app)?;
    if !p.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let list: Vec<RootMeta> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    // drop roots whose path vanished
    Ok(list
        .into_iter()
        .filter(|r| Path::new(&r.path).is_dir())
        .collect())
}

#[tauri::command]
fn save_roots(app: tauri::AppHandle, roots: Vec<RootMeta>) -> Result<(), String> {
    let p = roots_path(&app)?;
    let raw = serde_json::to_string_pretty(&roots).map_err(|e| e.to_string())?;
    fs::write(&p, raw).map_err(|e| e.to_string())
}

/// 选择单个 Markdown 文件（系统文件对话框）。
#[tauri::command]
fn pick_file() -> Result<Option<PickedFile>, String> {
    let picked = rfd::FileDialog::new()
        .add_filter("Markdown / Text", &["md", "markdown", "mdx", "txt", "html", "htm"])
        .pick_file();
    Ok(picked.map(|p| PickedFile {
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: p.to_string_lossy().to_string(),
    }))
}

/// 打开单个 `.md` 文件(双击/拖拽/单实例转发):校验扩展名后读内容并返回。
/// 纯只读:路径不写死囚笼(单文件浏览),仅防非 md 与超大文件;读出前先把路径解析成真身,
/// 再按 BOM / UTF-8 / GB18030 顺序解码并剥掉前导 BOM(B2/B3/B5)。
#[tauri::command]
fn open_path(path: String) -> Result<String, String> {
    let p0 = Path::new(&path);
    if !is_openable(p0) {
        return Err(format!("仅支持 {} 文件", ext_hint()));
    }
    let p = resolve_nearest(p0)?;
    let meta = fs::metadata(&p).map_err(|e| format!("无法读取文件: {e}"))?;
    if !meta.is_file() {
        return Err("不是文件".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("文件过大(超过 8MB)".into());
    }
    let bytes = fs::read(&p).map_err(|e| format!("读取失败: {e}"))?;
    let (md, enc) = decode_bytes(&bytes);
    remember_encoding(&p, enc); // 记编码:保存时按同一种编码 + 同样的 BOM 状态写回
    remember_read(&p); // 记指纹:保存时用来发现"外部已改"
    Ok(md)
}

// ───────────────────────── 库级全文搜索 ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    /// 命中文件绝对路径(可直接喂给 open_path / watch_file)
    pub path: String,
    /// 相对所属根的 posix 路径(喂给 read_text)
    pub rel: String,
    /// 命中文件所属根目录的绝对路径
    pub root: String,
    /// 1 基行号
    pub line: u32,
    /// 命中行文本(去首尾空白,截到 300 字符)
    pub text: String,
    /// 相关度得分(**后端排序用**,前端可忽略):文件名命中 > 一级标题命中 > 行号靠前。
    /// 排序在 search_library 里做完再截断,前端拿到就是"最相关的在前"。
    #[serde(default)]
    pub score: i64,
}

/// 按字符截断(不会切坏多字节字符)。
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        s.chars().take(max_chars).collect()
    }
}

fn search_dir(
    dir: &Path,
    root: &Path,
    needle: &str,
    limit: usize,
    depth: usize,
    hits: &mut Vec<SearchHit>,
) {
    if depth > MAX_DEPTH || hits.len() >= limit {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for ent in entries {
        if hits.len() >= limit {
            return;
        }
        let name = ent.file_name().to_string_lossy().into_owned();
        let Ok(ft) = ent.file_type() else { continue };
        let full = ent.path();
        if ft.is_dir() {
            if skip_dir_name(&name) {
                continue;
            }
            search_dir(&full, root, needle, limit, depth + 1, hits);
        } else if ft.is_file() && is_doc(&name) {
            search_file(&full, root, needle, limit, hits);
        }
    }
}

fn search_file(full: &Path, root: &Path, needle: &str, limit: usize, hits: &mut Vec<SearchHit>) {
    let Ok(meta) = fs::metadata(full) else { return };
    if meta.len() > MAX_BYTES {
        return;
    }
    // 非 UTF-8(GBK / GB18030 / UTF-16)不再整文件静默跳过 —— 走与 read_text 同一套解码,
    // 否则中文老文档"明明存在却搜不到"(审计 D-12 / B2)。
    let Ok(bytes) = fs::read(full) else { return };
    let (text, _) = decode_bytes(&bytes);
    let abs = full.to_string_lossy().into_owned();
    let rel = rel_posix(root, full);
    let root_s = root.to_string_lossy().into_owned();
    // 相关度信号:文件名命中(最像"我要找这个文件")> 一级标题命中 > 行号靠前
    let stem_lc = full
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let stem_hit = !stem_lc.is_empty() && stem_lc.contains(needle);
    let mut title_hit = false;
    let mut file_hits = 0usize;
    for (idx, line) in text.lines().enumerate() {
        if hits.len() >= limit || file_hits >= SEARCH_PER_FILE {
            return;
        }
        let line_no = (idx + 1) as u32;
        if line_no == 1 {
            let first = line.trim_start();
            title_hit = first.starts_with('#') && first.to_lowercase().contains(needle);
        }
        if line.len() < needle.len() || !line.to_lowercase().contains(needle) {
            continue;
        }
        let mut score: i64 = 0;
        if stem_hit {
            score += 1000;
        }
        if title_hit {
            score += 300;
        }
        score += 200 - i64::from(line_no.min(200)); // 越靠前越相关
        hits.push(SearchHit {
            path: abs.clone(),
            rel: rel.clone(),
            root: root_s.clone(),
            line: line_no,
            text: truncate_chars(line.trim(), SEARCH_TEXT_MAX),
            score,
        });
        file_hits += 1;
    }
}

/// 库级全文搜索:扫 roots.json 全部根(is_doc + skip_dir_name 过滤,>8MB 文件跳过,
/// 非 UTF-8 读不出就跳过),大小写不敏感子串匹配。
/// **排序(2026-10-25 加)**:先按放大池子收集(名字命中/标题命中/行号靠前得分),
/// 再按得分降序 → 行号升序 → 路径升序 排好,**最后**才截到 limit —— 这样"最相关的在前",
/// 而不是"目录遍历最先撞上的在前"。单文件最多 SEARCH_PER_FILE 条,防一个文件刷满屏。
/// 全程跑在 spawn_blocking,不占主线程。
#[tauri::command]
async fn search_library(query: String, limit: Option<usize>) -> Vec<SearchHit> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return vec![];
    }
    let cap = limit.unwrap_or(SEARCH_LIMIT_DEFAULT);
    if cap == 0 {
        return vec![];
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(app) = app_handle() else {
            return vec![];
        };
        let Ok(roots) = read_roots(&app) else {
            return vec![];
        };
        let mut hits: Vec<SearchHit> = Vec::new();
        let pool = cap.saturating_mul(6).clamp(600, 3000);
        for r in roots {
            if hits.len() >= pool {
                break;
            }
            let root = PathBuf::from(&r.path);
            search_dir(&root, &root, &needle, pool, 0, &mut hits);
        }
        hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then(a.line.cmp(&b.line))
                .then(a.path.cmp(&b.path))
        });
        hits.truncate(cap);
        hits
    })
    .await
    .unwrap_or_default()
}

// ───────────────────────── 外部文件变更监听 ─────────────────────────

/// 常驻持有的目录 watcher(同一时刻只有一个;watch_file 再调用会用新值替换旧值并析构旧的)。
static FS_WATCHER: std::sync::Mutex<Option<notify::RecommendedWatcher>> =
    std::sync::Mutex::new(None);

/// 监听某个文件**所在目录**(非递归),命中该文件即 `emit("fs-changed", 绝对路径)`;
/// 去抖 300ms:一次保存常触发多个底层事件,静默后才发一次(内容已定)。
/// 传 None 取消监听。watcher 常驻进程(绝不在这里 drop),重复调用替换旧目标不留僵尸。
#[tauri::command]
fn watch_file(path: Option<String>) -> Result<(), String> {
    // 先拆旧:watcher 一析构,回调连同 Sender 一起没了,旧协调线程随即退出(≤300ms)
    {
        let mut slot = FS_WATCHER.lock().map_err(|e| format!("监听锁失败: {e}"))?;
        *slot = None;
    }
    let Some(path) = path.filter(|p| !p.trim().is_empty()) else {
        return Ok(());
    };
    let target = PathBuf::from(&path);
    let dir = match target.parent().filter(|d| !d.as_os_str().is_empty()) {
        Some(d) => d.to_path_buf(),
        None => PathBuf::from("."),
    };
    if !dir.is_dir() {
        return Err(format!("目录不存在: {}", dir.display()));
    }
    let app = app_handle()?;
    let target_key = cage_key(&target);
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        for p in ev.paths {
            if cage_key(&p) == target_key {
                let _ = tx.send(p.to_string_lossy().into_owned());
                break;
            }
        }
    })
    .map_err(|e| format!("创建监听失败: {e}"))?;
    {
        use notify::Watcher as _;
        watcher
            .watch(&dir, notify::RecursiveMode::NonRecursive)
            .map_err(|e| format!("监听目录失败: {e}"))?;
    }
    // 协调线程:收到首个信号后继续吸 300ms 内的后续信号,静默后只发最后一次
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut latest = first;
            while let Ok(p) = rx.recv_timeout(FS_DEBOUNCE) {
                latest = p;
            }
            let _ = app.emit("fs-changed", latest);
        }
    });
    let mut slot = FS_WATCHER.lock().map_err(|e| format!("监听锁失败: {e}"))?;
    *slot = Some(watcher);
    Ok(())
}

// ───────────────────────── 导出与打开 ─────────────────────────

/// 无头打印最多等多少秒。到点就收摊报错 —— 判据是**产物文件**,不是浏览器肯不肯退出。
const PDF_WAIT_SECS: u64 = 30;

/// 导出 PDF:用系统自带的 Edge/Chrome **无头**模式,把导出的独立 HTML 打成 PDF —— 零新增依赖。
/// 纪律:全程 `CREATE_NO_WINDOW`,失败只返回可读错误字符串,**绝不弹任何 UI**(用户明确要求过);
/// 生成物不出现就报错,不做"假装成功"。
///
/// 2026-10-26 实测(ego lite 的 Chromium,本机唯一内核):`--headless=new --print-to-pdf` 会**挂住**:
/// 整个无头进程树(gpu/renderer/crashpad)都活着、157s 也不吐文件、也不退出。旧写法 `cmd.status()`
/// 会一直等它退出 —— 用户点「导出 PDF」就永久卡在"正在生成"。所以这里三条纪律:
/// ① 判据是**产物出现**(大小连续两次一致才算写完),不是浏览器退出码;
/// ② 到点必须 `taskkill /T` 把整树收干净,不给机器留一窝无头进程;
/// ③ 给无头进程一个**一次性 user-data-dir** —— 否则它会去抢用户正开着的浏览器的 profile
///    (或者被交接给已有实例,那条路根本不会打印)。
#[tauri::command]
fn export_pdf(html_path: String, pdf_path: String) -> Result<String, String> {
    if !Path::new(&html_path).is_file() {
        return Err(format!("导出 HTML 不存在: {html_path}"));
    }
    let browser = find_headless_browser()?;
    let url = format!("file:///{}", html_path.replace('\\', "/").replace(' ', "%20"));
    let profile = std::env::temp_dir().join(format!("tmmd-pdf-profile-{}", std::process::id()));
    let mut cmd = hidden_cmd(&browser);
    cmd.args([
        // 2026-10-26 实测:本机唯一内核(ego lite 的 Chromium)在 `--headless=new` 与旧式 `--headless`
        // 下**都不产出文件** —— 所以这里保持原样 `--headless=new`(Chrome/Edge ≥112 的正路),
        // 不为一个不打印的分支换旗号;真正的修法是下面那套"到点收摊"。
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-pdf-header-footer",
        &format!("--user-data-dir={}", profile.display()),
        &format!("--print-to-pdf={pdf_path}"),
        &url,
    ]);
    let started = std::time::SystemTime::now();
    // 4 **先清掉目标再打印**:判据是"产物出现",而同一个文档导出第二次时上一轮那份 PDF 就在那儿 ——
    //   不清理就会在浏览器还没打印完时"成功"返回旧文件(2026-10-26 实测:同一文档第二次导出
    //   665ms 就返回,产物是上一轮的空白页)。清不掉(被 PDF 阅读器占着)时靠下面的 mtime 新鲜度兜底:
    //   只认本次 spawn **之后**写出来的文件。
    let _ = fs::remove_file(&pdf_path);
    let mut child = cmd.spawn().map_err(|e| format!("起无头浏览器失败: {e}"))?;
    let size_of = |p: &str| fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let fresh = |p: &str| {
        fs::metadata(p)
            .and_then(|m| m.modified())
            .map(|t| t >= started)
            .unwrap_or(false)
    };
    let deadline = Instant::now() + Duration::from_secs(PDF_WAIT_SECS);
    let mut last = 0u64; // 连续两次量到同一个大小才算写完(避免读到半截 PDF)
    let mut produced = false;
    while Instant::now() < deadline {
        let now = size_of(&pdf_path);
        if now > 0 && now == last && fresh(&pdf_path) {
            produced = true;
            break;
        }
        last = now;
        if child.try_wait().ok().flatten().is_some() && now > 0 && fresh(&pdf_path) {
            // 浏览器自己退了、产物也在 → 就是成功(有些分支交接完就立刻退出)
            produced = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let pid = child.id();
    let _ = child.kill();
    let _ = child.wait();
    // `kill` 只收直接子进程;无头浏览器带一窝子进程,按 pid 整树收掉(pid 是我们自己起的那个,不碰用户实例)
    let _ = hidden_cmd("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
    let _ = fs::remove_dir_all(&profile);
    // 判据再加一层**内容**校验:错误页 / 空白 / 截断产物同样"存在且大小稳定",
    // 旧版只看到大小就报成功,用户拿到一页空白却提示"已生成"(审计 D-10 / B8)。
    if !produced || !has_pdf_magic(&pdf_path) {
        // 文案必须能被前端 ERR_MAP(^PDF 未生成)+ ERR_TAIL_MAP(可改用「打印 / 存 PDF」手动另存)
        // 完整吃掉:E11 会拿本文件全部中文错误串喂 trErr,EN 面留一个汉字就是红的。
        return Err("PDF 未生成;可改用「打印 / 存 PDF」手动另存".to_string());
    }
    Ok(pdf_path)
}

/// 产物是不是真 PDF:读前 5 字节比对 `%PDF-`。不是就不许报成功(审计 D-10 / B8)。
fn has_pdf_magic(p: &str) -> bool {
    use std::io::Read as _;
    let Ok(mut f) = fs::File::open(p) else {
        return false;
    };
    let mut head = [0u8; 5];
    f.read_exact(&mut head).is_ok() && &head == b"%PDF-"
}

/// 找一个可用的 Chromium 内核浏览器(Edge 先,Chrome 后)。顺序:
/// 显式指定 `TMMD_PDF_BROWSER`(自带 Chromium 的场景 / 测试缝)→ 常见安装目录 →
/// 注册表 App Paths(装在非默认目录的 Chrome/Edge 也认)。
/// 注意:本机(2026-10-25 实测)**没有装 Edge/Chrome**,所以这条链找不到时必须给可读提示,
/// 让用户改用「打印 / 存 PDF」,而不是假装成功。
fn find_headless_browser() -> Result<String, String> {
    for c in headless_browser_candidates() {
        if Path::new(&c).is_file() {
            return Ok(c);
        }
    }
    Err("找不到 Chromium 内核浏览器(Edge / Chrome / Brave / Vivaldi),无法直出 PDF(可改用「打印 / 存 PDF」)".into())
}

fn headless_browser_candidates() -> Vec<String> {
    let mut cands: Vec<String> = Vec::new();
    if let Ok(p) = std::env::var("TMMD_PDF_BROWSER") {
        if !p.trim().is_empty() {
            cands.push(p);
        }
    }
    for key in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(key) {
            for rel in [
                r"Microsoft\Edge\Application\msedge.exe",
                r"Google\Chrome\Application\chrome.exe",
                r"BraveSoftware\Brave-Browser\Application\brave.exe",
                r"Vivaldi\Application\vivaldi.exe",
                r"Chromium\Application\chrome.exe",
            ] {
                cands.push(format!("{base}\\{rel}"));
            }
        }
    }
    for exe in ["msedge.exe", "chrome.exe", "brave.exe", "vivaldi.exe"] {
        for hive in ["HKLM", "HKCU"] {
            let key = format!(r"{hive}\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
            if let Some(p) = reg_app_path(&key) {
                cands.push(p);
            }
        }
    }
    cands
}

/// 读 `App Paths\<exe>` 的默认值(路径可能是非 ASCII,所以只取 "REG_SZ" 之后那段并去引号)。
/// `to_ascii_lowercase` 只改 ASCII 字节、不改长度,所以用小写串找到的下标可以直接切原串。
fn reg_app_path(key: &str) -> Option<String> {
    let out = hidden_cmd("reg")
        .args(["query", key, "/ve"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains(".exe") {
            if let Some(idx) = lower.find("reg_sz") {
                let p = line[idx + 6..].trim().trim_matches('"').trim().to_string();
                if !p.is_empty() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// 导出:只允许 .html/.htm,写盘后返回绝对路径(「导出 HTML」)。
#[tauri::command]
fn export_file(path: String, content: String) -> Result<String, String> {
    let p = Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "html" && ext != "htm" {
        return Err("仅支持 .html / .htm 文件".into());
    }
    // 写盘前先把目标解析到最近的祖先真身(B5):junction / symlink 不会把"看起来在导出目录"的写带出去
    let target = resolve_nearest(p)?;
    fs::write(&target, content).map_err(|e| format!("导出失败: {e}"))?;
    // 直接返回绝对路径:canonicalize 在 Windows 会带上 `\\?\` 前缀,喂给 start/浏览器反而出问题
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|d| d.join(p))
            .unwrap_or_else(|_| p.to_path_buf())
    };
    Ok(abs.to_string_lossy().into_owned())
}

/// 用系统默认程序打开一个**白名单内的**目标:http / https / mailto 链接,或真实存在的本地文件/目录。
/// 旧写法把前端给的任意串拼进 `cmd /C start "" <path>`:cmd 会**二次解析**命令行,`&`/`|`/`"` 直接变成
/// 命令分隔与注入点(`C:\a&calc`),`start` 本身还能执行 .exe/.bat(审计 D-04 / B6)。
/// 现在:协议白名单 + 存在性校验 + `ShellExecuteW` 传指针 —— 不经 cmd,shell 元字符失去一切意义。
#[tauri::command]
fn open_any(path: String) -> Result<(), String> {
    let target = path.trim();
    if target.is_empty() {
        return Err("打开失败:路径为空".into());
    }
    match url_scheme(target) {
        Some(scheme) if scheme == "http" || scheme == "https" || scheme == "mailto" => {}
        // `file:` / `javascript:` / `ms-settings:` / 自造协议:一律拒绝
        Some(_) => return Err("打开失败:不支持的协议".into()),
        // 没有协议前缀 = 本地路径,必须真实存在(否则 `start` 会去找同名程序执行)
        None => {
            if !Path::new(target).exists() {
                return Err(format!("打开失败:路径不存在: {target}"));
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let op = wide("open");
        let file = wide(target);
        let rc = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        // ShellExecute 的返回值 <= 32 都是错误码(不是句柄):照实报错,不假装成功
        if rc <= 32 {
            return Err(format!("打开失败: code={rc}"));
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        Err("仅 Windows 支持".to_string())
    }
}

// ───────────────────────── 自研更新器(2026-10-25,用户定调) ─────────────────────────
// 要求原话:"自动更新要自研版本,要在程序内部能自己更新"(不跳浏览器、不装别人的更新框架)。
// 信任链:HTTPS + 清单里的 SHA-256(下载后强校验,不符即删)+ URL 必须落在受信任前缀内。
// 没有 Authenticode 代码签名,所以"清单从哪来"就是唯一信任根 —— 默认只认本仓 release 资产。
// 测试缝:`TMMD_UPDATE_ENDPOINT` 覆盖清单地址(此时放行 http://127.0.0.1 与本机路径,
// 用来在不动线上仓库的前提下跑通整条链路)。
const UPDATE_FILE: &str = "update_state.json";
const UPDATE_CHECK_INTERVAL: u64 = 24 * 3600; // 自动检查节流:一天一次
/// 信任根:本仓 release 资产。**只在 host + 路径段都核对过之后**才算可信(见 update_url_trusted)。
const UPDATE_TRUSTED_HOST: &str = "github.com";
const UPDATE_TRUSTED_PATHS: [&str; 2] = [
    "/nakamotosai/tmmd/releases/download/",
    "/nakamotosai/tmmd/releases/latest/download/",
];
const UPDATE_MANIFEST_URL: &str =
    "https://github.com/nakamotosai/TMMD/releases/latest/download/latest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub version: String,
    pub asset: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateState {
    #[serde(default)]
    pub last_checked: Option<u64>,
    #[serde(default)]
    pub last_prompted: Option<String>,
    #[serde(default)]
    pub skipped_version: Option<String>,
    #[serde(default)]
    pub remind_after: Option<u64>,
    /// 最近一次成功检查看到的**更新版本清单**(回答真相,不只是"检查过")。
    /// 2026-10-29 加:`update_check` 被节流时不再靠它说"已是最新"——那是假话。
    #[serde(default)]
    pub remote: Option<UpdateManifest>,
    /// 上次成功检查时**本程序**的版本号:装完新版立刻重查一次,不吃上一版留下的 24h 节流。
    #[serde(default)]
    pub checked_by_version: Option<String>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn update_state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    config_path(app, UPDATE_FILE)
}

fn read_update_state(app: &tauri::AppHandle) -> UpdateState {
    update_state_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_update_state(app: &tauri::AppHandle, st: &UpdateState) {
    if let Ok(p) = update_state_path(app) {
        if let Ok(raw) = serde_json::to_string_pretty(st) {
            let _ = fs::write(p, raw);
        }
    }
}

/// 解析版本号为 (主, 次, 修订, 预发布段)。`v` 前缀与 `+build` 元数据都允许;缺段补 0。
/// 旧写法把所有非数字段当 0,于是 `2.0.0-beta` 与 `2.0.0` 判等(用过测试版的用户永远收不到正式版),
/// 而 `1.9.2-rc.1` 反被判成比 `1.9.2` 新(审计 D-09 / B8)。
fn parse_version(v: &str) -> ([u64; 3], Vec<String>) {
    let core = v.trim_start_matches(['v', 'V']);
    let core = core.split('+').next().unwrap_or(""); // 构建元数据不参与比较
    let (nums_s, pre_s) = match core.split_once('-') {
        Some((a, b)) => (a, b),
        None => (core, ""),
    };
    let mut nums = [0u64; 3];
    let mut extra: Vec<String> = Vec::new();
    for (i, seg) in nums_s.split('.').enumerate() {
        if i < 3 {
            nums[i] = seg.trim().parse::<u64>().unwrap_or(0);
        } else if !seg.trim().is_empty() {
            // `1.9.2.1` 这类非 SemVer 写法:多出来的段按预发布段处理(低于同号正式版),不 panic
            extra.push(seg.trim().to_string());
        }
    }
    let mut pre: Vec<String> = pre_s
        .split('.')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    pre.extend(extra);
    (nums, pre)
}

/// 预发布段比较(SemVer §11):数字段按数值、字母段按 ASCII、数字段 < 字母段;前缀相同则短的更小。
fn cmp_pre(a: &[String], b: &[String]) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    for (x, y) in a.iter().zip(b.iter()) {
        let ord = match (x.parse::<u64>().ok(), y.parse::<u64>().ok()) {
            (Some(p), Some(q)) => p.cmp(&q),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => x.cmp(y),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    a.len().cmp(&b.len())
}

/// 远端是否比本地新:主 / 次 / 修订逐段数值比;**同号时,有预发布段的 < 无预发布段的**。
fn is_newer(remote: &str, local: &str) -> bool {
    use std::cmp::Ordering;
    let (an, ap) = parse_version(remote);
    let (bn, bp) = parse_version(local);
    for i in 0..3 {
        match an[i].cmp(&bn[i]) {
            Ordering::Greater => return true,
            Ordering::Less => return false,
            Ordering::Equal => {}
        }
    }
    match (ap.is_empty(), bp.is_empty()) {
        (true, true) => false,
        (true, false) => true,  // 正式版 > 同号预发布
        (false, true) => false, // 预发布 < 同号正式版
        (false, false) => cmp_pre(&ap, &bp) == Ordering::Greater,
    }
}

/// `http:` / `mailto:` 这类协议前缀;`C:\` 这种单字母盘符不算(冒号在第 1 位)。
/// 手写而不引 `url` crate:本工单不允许改 Cargo.toml 依赖(见交付说明)。
fn url_scheme(s: &str) -> Option<String> {
    let idx = s.find(':')?;
    if idx < 2 {
        return None;
    }
    let head = &s[..idx];
    if head
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        Some(head.to_ascii_lowercase())
    } else {
        None
    }
}

/// URL 拆成(协议, 主机[:端口], 路径),协议与主机统一小写;拆不出来返回 None。
fn split_url(u: &str) -> Option<(String, String, String)> {
    let u = u.trim();
    let (scheme, rest) = u.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    // 带 userinfo 的 `https://github.com@evil.tld/` 一律不认(host 是 evil.tld,肉眼却像本仓)
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let path = tail.split(['?', '#']).next().unwrap_or("").to_string();
    Some((
        scheme.to_ascii_lowercase(),
        authority.to_ascii_lowercase(),
        path,
    ))
}

/// 清单 URL 是否可信。设了 TMMD_UPDATE_ENDPOINT(测试缝)时额外放行本机地址。
/// 2026-11 加固(审计 D-08 / B7):不再只看字符串前缀 —— 先解析出 scheme / host / 路径,
/// 路径里出现 `..`(或 `%2e`)一律拒绝;否则 `.../releases/download/../../../../other/repo/...`
/// 因为"字面以可信前缀开头"就能指向**别人的仓库**。
fn update_url_trusted(url: &str) -> bool {
    if let Some((scheme, host, path)) = split_url(url) {
        let lc_path = path.to_ascii_lowercase();
        let dotted = lc_path.split('/').any(|seg| seg == "..") || lc_path.contains("%2e");
        if !dotted
            && scheme == "https"
            && host == UPDATE_TRUSTED_HOST
            && UPDATE_TRUSTED_PATHS
                .iter()
                .any(|p| lc_path.starts_with(*p))
        {
            return true;
        }
    }
    if std::env::var("TMMD_UPDATE_ENDPOINT").is_ok() {
        return url.starts_with("http://127.0.0.1") || url.starts_with("file://");
    }
    false
}

/// 已知的"比当前版本新"的清单(缓存)。`force` 时连"跳过此版本"也不认 —— 手动检查必须能看见。
fn pending_update(st: &UpdateState, cur: &str, force: bool) -> Option<UpdateManifest> {
    st.remote
        .as_ref()
        .filter(|m| is_newer(&m.version, cur))
        .filter(|m| force || st.skipped_version.as_deref() != Some(m.version.as_str()))
        .cloned()
}

/// 检查更新。`Some` = **确实存在**比当前更新的版本(不再因为节流而假装"已是最新")。
///
/// 2026-10-29 实测缺陷(用户报「有新版本完全没有任何提示」):旧版把"省一次网络请求"和
/// "要不要告诉用户"混在同一个 `if` 里 —— 节流命中就 `Ok(None)`,前端于是显示"已是最新版本"。
/// 后果:上次检查**之后**才发布的新版,本地最长 24 小时完全无声;而且刚装完新版本也会被
/// 上次留下的 `last_checked` 压住,一次都不查。
/// 现在:节流只决定**要不要打网络**,答案(缓存 `remote`)照给;该不该弹窗打断用户由
/// 前端的 `update_prompt_gate` 决定 —— 提示的可见性与网络节流彻底解耦。
#[tauri::command]
fn update_check(app: tauri::AppHandle, force: Option<bool>) -> Result<Option<UpdateManifest>, String> {
    let force = force.unwrap_or(false);
    let mut st = read_update_state(&app);
    let now = now_secs();
    let cur = env!("CARGO_PKG_VERSION");
    // 打网络的三个条件:强制检查 / 距上次成功检查够 24h / **当前这个版本还没查过**。
    let net = force
        || (st.checked_by_version.as_deref() != Some(cur)
            && st
                .last_checked
                .map_or(true, |l| now.saturating_sub(l) >= UPDATE_CHECK_INTERVAL));
    if !net {
        return Ok(pending_update(&st, cur, force));
    }
    let url = std::env::var("TMMD_UPDATE_ENDPOINT").unwrap_or_else(|_| UPDATE_MANIFEST_URL.to_string());
    let fetched = ureq::get(&url)
        .call()
        .map_err(|e| format!("取更新清单失败: {e}"))
        .and_then(|r| {
            r.into_body()
                .read_to_string()
                .map_err(|e| format!("读更新清单失败: {e}"))
        });
    let body = match fetched {
        Ok(b) => b,
        // 拿不到新答案时,已知的答案不能因为一个网络错误就消失 ——
        // 报"有新版本"比报"已是最新"诚实;真正没有已知答案时才把错误交出去。
        Err(e) => {
            return match pending_update(&st, cur, force) {
                Some(m) => Ok(Some(m)),
                None => Err(e),
            }
        }
    };
    // 清单是信任根:不能因为一个看不见的 BOM 整体失效。2026-10-25 实测:GitHub 上的 asset 带
    // UTF-8 BOM(PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM),serde_json 直接
    // 报 "expected value at line 1 column 1" —— 通道看着通、实际全军覆没。生成脚本已改成无 BOM,
    // 这里再兜一层(顺手吃掉首尾空白)。
    let body = body.trim_start_matches('\u{feff}').trim();
    let m: UpdateManifest =
        serde_json::from_str(body).map_err(|e| format!("更新清单无效: {e}"))?;
    if m.sha256.len() != 64 || !m.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("更新清单里的 sha256 不合法".into());
    }
    if !update_url_trusted(&m.url) {
        return Err(format!("更新包来源不可信: {}", m.url));
    }
    st.last_checked = Some(now);
    st.checked_by_version = Some(cur.to_string());
    if !is_newer(&m.version, cur) {
        st.remote = None; // 追平(或服务端回退):旧缓存必须清掉,否则会一直报一个不存在的"新版"
        write_update_state(&app, &st);
        return Ok(None);
    }
    st.remote = Some(m.clone()); // 缓存下来:下次不打网络也能回答"有新版本"
    let report = force || st.skipped_version.as_deref() != Some(m.version.as_str());
    write_update_state(&app, &st);
    Ok(if report { Some(m) } else { None })
}

/// 前端"能不能弹窗打断用户":`ok` / `later`(说过"稍后")/ `skip`(说过"跳过此版本")。
/// 只读、不改状态 —— 弹不弹是前端的决定,后端正本清源只负责"现在有没有更新"。
#[tauri::command]
fn update_prompt_gate(app: tauri::AppHandle, version: String) -> String {
    let st = read_update_state(&app);
    if st.skipped_version.as_deref() == Some(version.as_str()) {
        return "skip".into();
    }
    if st.remind_after.map_or(false, |ra| now_secs() < ra) {
        return "later".into();
    }
    "ok".into()
}

/// 本次进程里"刚下载且 SHA-256 对得上"的安装包:(落位绝对路径, 小写十六进制 sha256)。
/// 不进 `UpdateState` —— 那份 JSON 每次调用都从盘上重读,写进去也留不住;而且"上次校验过"
/// 不等于"现在还是那份字节"。**拒绝是默认值**:没有这条记录,`update_install` 一律报错。
static UPDATE_DOWNLOADED: std::sync::LazyLock<std::sync::Mutex<Option<(PathBuf, String)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// 清单里的 `asset` 只许是**纯文件名**:不许有分隔符 / 盘符 / `..`,也不许带 PS / cmd 元字符
/// (它会进安装脚本的启动行)。旧版直接 `dir.join(&manifest.asset)`,`..\..\Startup\x.exe`
/// 就是把包写到启动目录(审计 D-03)。
fn safe_asset_name(asset: &str) -> Result<String, String> {
    let bad = asset.trim().is_empty()
        || asset.contains('/')
        || asset.contains('\\')
        || asset.contains(':')
        || asset.contains("..")
        || asset.chars().any(|c| {
            matches!(
                c,
                '"' | '\'' | '&' | '|' | '^' | '%' | '<' | '>' | '!' | '`' | '$' | '\r' | '\n'
            )
        });
    let name = Path::new(asset)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_string())
        .unwrap_or_default();
    if bad || name.is_empty() || name == "." || name == ".." {
        return Err("更新包名非法".into());
    }
    Ok(name)
}

/// 下载更新包到配置目录的 updates/,边下边算 SHA-256,完成后比对;不符直接删掉并报错。
/// 进度通过 `update-progress` 事件回前端({received,total})。
/// 顺序钉死:下载 → 算 SHA-256 → 与清单比对 → **记下这个包** → 才轮到 install(审计 B1)。
#[tauri::command]
fn update_download(app: tauri::AppHandle, manifest: UpdateManifest) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    if !update_url_trusted(&manifest.url) {
        return Err("更新包来源不可信".into());
    }
    if manifest.size > 512 * 1024 * 1024 {
        return Err("更新包体积异常".into());
    }
    // 文件名只认 basename(清单由前端传入,不可信)
    let asset = safe_asset_name(&manifest.asset)?;
    let dir = config_path(&app, "updates")?;
    fs::create_dir_all(&dir).map_err(|e| format!("建更新目录失败: {e}"))?;
    let dest = dir.join(&asset);
    let part = dir.join(format!("{asset}.part"));
    let mut resp = ureq::get(&manifest.url)
        .call()
        .map_err(|e| format!("下载失败: {e}"))?;
    let total = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(manifest.size);
    let mut reader = resp.body_mut().as_reader();
    let mut file = fs::File::create(&part).map_err(|e| format!("建临时文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    loop {
        let n = std::io::Read::read(&mut reader, &mut buf).map_err(|e| format!("读下载流失败: {e}"))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("写盘失败: {e}"))?;
        hasher.update(&buf[..n]);
        received += n as u64;
        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = std::time::Instant::now();
            let _ = app.emit(
                "update-progress",
                serde_json::json!({ "received": received, "total": total }),
            );
        }
    }
    drop(file);
    let got = format!("{:x}", hasher.finalize());
    if !got.eq_ignore_ascii_case(&manifest.sha256) {
        let _ = fs::remove_file(&part);
        return Err(format!(
            "校验失败: 期望 {}\n实际 {}",
            manifest.sha256, got
        ));
    }
    let _ = fs::remove_file(&dest);
    fs::rename(&part, &dest).map_err(|e| format!("落位失败: {e}"))?;
    // 校验已通过、字节已落位:此刻才把"这个包可以装"记下来(install 只认这一条记录)
    let sha = got.to_ascii_lowercase();
    if let Ok(mut slot) = UPDATE_DOWNLOADED.lock() {
        *slot = Some((dest.clone(), sha));
    }
    let _ = app.emit(
        "update-progress",
        serde_json::json!({ "received": received, "total": total, "done": true }),
    );
    Ok(dest.to_string_lossy().to_string())
}

/// 安装:写一个临时 PS 脚本(等本进程退出 → 静默装 → 自删),隐藏窗口起它,然后由前端放行关窗。
/// 为什么不等自己退出:*安装包要覆盖正在运行的 exe*,必须先让本进程走。
/// 2026-11 加固(审计 D-02 / D-03 / B1):
/// 1 只认**本次进程里刚下载且 SHA-256 校验通过**的那一个文件:规范化路径必须相同,执行前再重算一次 SHA;
/// 2 脚本正文不再拼接任何外部字符串 —— 路径经 `-File <脚本> <参数>` 进 `$Target`,
///   日志行只用 `$Target` 插值;旧版把 path 裸插进单引号串,路径里一个 `'` 就是 PS 注入;
/// 3 落位必须仍在配置目录的 `updates/` 下。
#[tauri::command]
fn update_install(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("更新包不存在: {path}"));
    }
    // 没有"刚校验过的包"这条记录 = 拒绝(默认值);不再"只要是本机存在的文件就执行"
    let (want, want_sha) = match UPDATE_DOWNLOADED.lock() {
        Ok(g) => g
            .clone()
            .ok_or_else(|| "没有已校验的更新包,请先下载".to_string())?,
        Err(_) => return Err("更新状态锁失败".into()),
    };
    let got = p
        .canonicalize()
        .map_err(|e| format!("无法解析更新包路径: {e}"))?;
    let want_can = want
        .canonicalize()
        .map_err(|_| "已校验的更新包已不存在,请重新下载".to_string())?;
    if cage_key(&got) != cage_key(&want_can) {
        return Err("更新包未经校验".into());
    }
    let updates_dir = config_path(&app, "updates")?;
    if !is_under_root(&updates_dir, &got) {
        return Err("更新包位置非法".into());
    }
    // 执行前重算 SHA-256:让"要执行的字节"确实等于"校验过的字节"(下载与安装之间可以被动手脚)
    {
        use sha2::{Digest, Sha256};
        let bytes = fs::read(&got).map_err(|e| format!("读更新包失败: {e}"))?;
        let got_sha = format!("{:x}", Sha256::digest(&bytes));
        if got_sha.to_ascii_lowercase() != want_sha {
            let _ = fs::remove_file(&got);
            if let Ok(mut slot) = UPDATE_DOWNLOADED.lock() {
                *slot = None;
            }
            return Err("更新包校验失败: 内容已变".into());
        }
    }
    let pid = std::process::id();
    let dir = std::env::temp_dir();
    let script = dir.join(format!("tmmd-update-{pid}.ps1"));
    let log = dir.join("tmmd-update.log");
    let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
    // .exe 直接静默装(NSIS /S);其它后缀(测试替身 / 自定义脚本)交给 cmd /c。
    // `Start-Process` 没有 `-LiteralPath`(它本来也不做通配展开),`-FilePath` 收到的就是字面量。
    let launch = if want
        .to_string_lossy()
        .to_ascii_lowercase()
        .ends_with(".exe")
    {
        "Start-Process -FilePath $Target -ArgumentList '/S'".to_string()
    } else {
        "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $Target, '/S' -WindowStyle Hidden"
            .to_string()
    };
    // 正文里没有一处来自外部的字符串拼接:`$Target` 由 PS 自己从命令行参数取,
    // `'` / `;` / `$` / 反引号都只是普通字符;唯一仍拼接的 `$log` 是我们自己的临时路径且过了 `q()`。
    let body = format!(
        "param([string]$Target)\r\n\
         $ErrorActionPreference='SilentlyContinue'\r\n\
         $log = {log}\r\n\
         Add-Content -LiteralPath $log -Value ((Get-Date).ToString('s') + ' helper start pid={pid} target=' + $Target)\r\n\
         Start-Sleep -Milliseconds 800\r\n\
         Wait-Process -Id {pid} -Timeout 120\r\n\
         Add-Content -LiteralPath $log -Value 'app exited, launching installer'\r\n\
         {launch}\r\n\
         Add-Content -LiteralPath $log -Value ('launch returned ' + $LASTEXITCODE)\r\n\
         Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force\r\n",
        log = q(&log.to_string_lossy()),
        pid = pid,
        launch = launch,
    );
    fs::write(&script, body).map_err(|e| format!("写安装脚本失败: {e}"))?;
    hidden_cmd("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script)
        // 路径走参数而不是脚本正文;用落位记录里的原始路径(不带 `\\?\`),PS/Start-Process 才认
        .arg(&want)
        .spawn()
        .map_err(|e| format!("起安装脚本失败: {e}"))?;
    // 记一笔:装完之后"已提示过这个版本";缓存也要清 —— 正在装的就是它,重启后重新查。
    let mut st = read_update_state(&app);
    st.last_prompted = Some(env!("CARGO_PKG_VERSION").to_string());
    st.remote = None;
    write_update_state(&app, &st);
    Ok(())
}

/// 记录用户的选择(跳过此版本 / 稍后提醒)。
#[tauri::command]
fn update_note(app: tauri::AppHandle, version: String, action: String) -> Result<(), String> {
    let mut st = read_update_state(&app);
    st.last_prompted = Some(version.clone());
    match action.as_str() {
        "skip" => {
            st.skipped_version = Some(version);
            st.remind_after = None;
        }
        "later" => {
            st.remind_after = Some(now_secs() + 3 * 24 * 3600);
        }
        _ => {}
    }
    write_update_state(&app, &st);
    Ok(())
}

// ───────────────────────── 原生壳语言(托盘 + 原生对话框) ─────────────────────────
/// 当前语言码:0=zh(默认)| 1=ja | 2=en。
/// 无锁原子:`set_lang` 只写一次、托盘/对话框读取零成本;不存在"读到半个字符串"的风险。
/// 启动默认 zh,前端 boot 后会立刻调 `set_lang` 覆盖,所以这里不去读配置。
static LANG: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lang {
    Zh = 0,
    Ja = 1,
    En = 2,
}

impl Lang {
    /// 语言码 → 语言;**非法输入(未知码/空串)一律回落 zh**。
    fn from_code(code: &str) -> Self {
        match code {
            "ja" => Lang::Ja,
            "en" => Lang::En,
            _ => Lang::Zh,
        }
    }

    fn current() -> Self {
        match LANG.load(std::sync::atomic::Ordering::Relaxed) {
            1 => Lang::Ja,
            2 => Lang::En,
            _ => Lang::Zh,
        }
    }

    fn store(self) {
        LANG.store(self as u8, std::sync::atomic::Ordering::Relaxed);
    }
}

/// 原生壳需要跟随界面语言的文案 —— **恰好这 5 条**。
/// 本文件其余含中文字面量全是错误信息:前端用正则表把它们映射成字典键,一律不动。
#[derive(Clone, Copy)]
enum Msg {
    TrayShow,
    TrayHide,
    TrayQuit,
    PickFolderTitle,
    UntitledBase,
}

/// 查表:文案 × 语言 → 静态串(顺带 0 分配)。
const fn tr(msg: Msg, lang: Lang) -> &'static str {
    use Lang::{En, Ja, Zh};
    match (msg, lang) {
        (Msg::TrayShow, Zh) => "显示主窗口",
        (Msg::TrayShow, En) => "Show window",
        (Msg::TrayShow, Ja) => "ウィンドウを表示",
        (Msg::TrayHide, Zh) => "隐藏到托盘",
        (Msg::TrayHide, En) => "Hide to tray",
        (Msg::TrayHide, Ja) => "トレイに格納",
        (Msg::TrayQuit, Zh) => "退出 TMMD",
        (Msg::TrayQuit, En) => "Quit TMMD",
        (Msg::TrayQuit, Ja) => "TMMD を終了",
        (Msg::PickFolderTitle, Zh) => "选择 Markdown 文件夹",
        (Msg::PickFolderTitle, En) => "Choose a Markdown folder",
        (Msg::PickFolderTitle, Ja) => "Markdown フォルダを選択",
        (Msg::UntitledBase, Zh) => "未命名",
        (Msg::UntitledBase, En) => "untitled",
        (Msg::UntitledBase, Ja) => "無題",
    }
}

/// 当前语言下的文案
fn t(msg: Msg) -> &'static str {
    tr(msg, Lang::current())
}

/// 托盘菜单句柄:setup 时存一次,`set_lang` 只改这几项的**文字**。
/// 刻意不重建托盘图标 —— 左键单击切换、图标、tooltip、事件回调全部保持原样。
#[derive(Default)]
struct TrayMenu(std::sync::Mutex<Option<tauri::menu::Menu<tauri::Wry>>>);

/// 前端 boot / 切语言时调用:存下语言码,并就地刷新托盘菜单文字。
/// 菜单还没建好(理论上不会:托盘先于窗口显示建好)则只存码,`setup_tray` 建表时本来就按当前语言取字。
#[tauri::command]
fn set_lang(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    let l = Lang::from_code(&lang);
    l.store();
    // 托盘可能压根没建起来(setup_tray 失败只记 eprintln):那也不用崩,存码就够了
    let Some(state) = app.try_state::<TrayMenu>() else {
        return Ok(());
    };
    let guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return Ok(()), // 锁中毒只影响刷文字,不该让前端收到异常
    };
    if let Some(menu) = guard.as_ref() {
        for (id, msg) in [
            ("show", Msg::TrayShow),
            ("hide", Msg::TrayHide),
            ("quit", Msg::TrayQuit),
        ] {
            if let Some(tauri::menu::MenuItemKind::MenuItem(item)) = menu.get(id) {
                if let Err(e) = item.set_text(tr(msg, l)) {
                    // 只是菜单文字没刷新,不值得给用户弹错;留痕即可
                    eprintln!("tray menu text update failed: {e}");
                }
            }
        }
    }
    Ok(())
}

// ───────────────────────── 托盘(E 类:多窗口暂不做,前端是单窗口设计) ─────────────────────────
/// 托盘:显示 / 隐藏 / 退出。
/// **退出走关窗守卫**:这里调 `win.close()` 而不是 `process::exit`,于是未保存内容照样会被拦下来问一句
/// (托盘菜单不该成为绕过守卫的后门)。
fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let show = MenuItem::with_id(app, "show", t(Msg::TrayShow), true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", t(Msg::TrayHide), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", t(Msg::TrayQuit), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;
    // 留一份菜单句柄给 set_lang 改文字(不重建托盘,左键单击等设置原样保留)
    let _ = app.manage(TrayMenu(std::sync::Mutex::new(Some(menu.clone()))));
    let mut builder = TrayIconBuilder::with_id("tmmd-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("TMMD")
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "hide" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            "quit" => {
                // 关窗 → CloseRequested → 前端守卫(有未保存就弹三选)
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击:在显示/隐藏之间切换(与大多数 Windows 应用一致)
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // v1.9.3 测试缝:置 TMMD_TEST_NOACTIVATE=1 时不注册单实例插件。
    // 否则验证用的 debug 实例会被用户正开着的正式版"吃掉"(转发 argv 后自己退出,窗口根本不出现),
    // 一条 e2e 都跑不了 —— 而且为了让验证实例起来还得先把用户的窗口关掉。
    // 该变量本来就是验证专用(`launch-on-secondary.ps1` 写它),不影响正常安装版。
    let builder = if std::env::var_os("TMMD_TEST_NOACTIVATE").is_none() {
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 第二及以后实例:argv[1..] = 双击/关联/命令行传进来的文档路径 → 逐个转发前端渲染。
            // v1.9.3:旧实现只取 argv[1],一次传多个文件时后面的全丢。
            let mut forwarded = false;
            for p in argv.iter().skip(1) {
                if !p.starts_with('-') {
                    if let Some(ext) = Path::new(p.as_str()).extension().and_then(|e| e.to_str()) {
                        if DOC_EXTS.contains(&ext.to_ascii_lowercase().as_str()) || TEXT_EXTS.contains(&ext.to_ascii_lowercase().as_str()) {
                            let _ = app.emit("open-file", p.clone());
                            forwarded = true;
                        }
                    }
                }
            }
            if !forwarded && argv.len() > 1 {
                // 不是文档参数(旧行为:盲目转发第一个)也照旧转一次,避免"点了没反应"
                if let Some(p) = argv.get(1) {
                    let _ = app.emit("open-file", p.clone());
                }
            }
            // v1.9.3:验证/自动化实例(TMMD_TEST_NOACTIVATE)不许抢焦点 —— 旧实现无条件
            // set_focus(),会把用户从当前窗口踢开(审计 B16)。
            if std::env::var_os("TMMD_TEST_NOACTIVATE").is_none() {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
        }))
    } else {
        builder
    };
    builder
        .setup(|app| {
            // 冷启动(首个进程):argv[1] 可能带着 .md 路径,先存起来等前端就绪再取
            let first = std::env::args().nth(1);
            *app.state::<StartupPending>().0.lock().unwrap() = first;
            // 命令里拿 app(配置目录 / emit 事件)的唯一通道
            let _ = APP_HANDLE.set(app.handle().clone());
            // 尺寸自适应:还原上次几何(v2=物理坐标+按坐标找屏,副屏也能原样还原),否则主屏工作区 88% 居中;
            // 必须在 paint_glass 之前,避免按旧尺寸先算一遍绘制。
            apply_initial_window(app.handle());
            // R3b 玻璃底:Pebrel 配方 legacy AccentPolicy(tint 沿用 v0.3.2 实测值),
            // 不再走 TRANSIENTWINDOW(DC 窗上是灰板)。失败只记忽略,不崩窗口。
            if let Some(win) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    let _ = paint_glass(&win, true, 20, 20, 22, 100);
                }
                // Show only after the position and glass are final: the window is created with
                // visible:false, so nothing is painted until here (no flash on the user's primary screen).
                // TMMD_TEST_NOACTIVATE=1 (automation only): show with SW_SHOWNOACTIVATE so the window
                // does not steal foreground focus from whatever the user is doing.
                if std::env::var("TMMD_TEST_NOACTIVATE").is_ok() {
                    // 留痕:自动化用例要能确认这条分支真的走了(否则会误判"没抢焦点"是代码生效)
                    let _ = fs::write(
                        std::env::temp_dir().join("tmmd-noactivate.marker"),
                        format!("{}", std::process::id()),
                    );
                    #[cfg(target_os = "windows")]
                    {
                        use windows_sys::Win32::UI::WindowsAndMessaging::{
                            GWL_EXSTYLE, GetWindowLongPtrW, SW_SHOWNOACTIVATE, SetWindowLongPtrW,
                            ShowWindow, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
                        };
                        if let Ok(h) = win.hwnd() {
                            // 测试实例:摘掉任务栏按钮(WS_EX_TOOLWINDOW)。
                            // 否则用户主屏的任务栏会多出一个按钮 + 悬停气泡(2026-10-25 被投诉第二次),
                            // 而测试窗口本来在副屏上跑,不该在用户的任务栏里露脸。
                            unsafe {
                                let ex = GetWindowLongPtrW(h.0 as _, GWL_EXSTYLE) as u32;
                                let ex = (ex | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
                                SetWindowLongPtrW(h.0 as _, GWL_EXSTYLE, ex as isize);
                            }
                            unsafe { ShowWindow(h.0 as _, SW_SHOWNOACTIVATE) };
                        }
                        // 注意:这里不能再 unminimize()/set_focus() —— SW_RESTORE 会激活窗口,前台照样被抢
                        // (实测:不激活显示 + unminimize 仍是"抢焦点")。
                    }
                } else {
                    let _ = win.show();
                }
            }
            // 几何落盘去抖线程:Resized/Moved 只投递,静默 500ms 后才写 window.json
            spawn_window_save_worker(app.handle().clone());
            // 托盘(失败只记忽略:没有托盘不该影响主流程启动)
            if let Err(e) = setup_tray(app) {
                eprintln!("tray setup failed: {e}");
            }
            Ok(())
        })
        .manage(StartupPending::default())
        .manage(WindowSaveState::default())
        .on_window_event(|window, event| {
            let app = window.app_handle().clone();
            match event {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                    queue_window_save(window, &app)
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    flush_window_save(window, &app);
                    if !CLOSE_OK.load(std::sync::atomic::Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.emit("close-requested", ());
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_info,
            allow_close,
            export_pdf,
            update_check,
            update_prompt_gate,
            update_download,
            update_install,
            update_note,
            create_file,
            rename_file,
            delete_file,
            pick_save,
            open_path,
            pick_folder,
            pick_file,
            list_md_tree,
            read_text,
            write_text,
            save_path,
            load_roots,
            save_roots,
            pending_open,
            set_glass_material,
            get_glass_state,
            open_default_apps_settings,
            get_md_default,
            system_effects_state,
            watch_file,
            search_library,
            export_file,
            open_any,
            set_lang
        ])
        .run(tauri::generate_context!())
        .expect("error while running TMMD");
}

/// 冷启动待打开路径：setup 时存入，前端 boot 后取走（取后清空，避免重复打开）
#[derive(Default)]
struct StartupPending(std::sync::Mutex<Option<String>>);

#[tauri::command]
fn pending_open(state: tauri::State<StartupPending>) -> Result<Option<String>, String> {
    Ok(state.0.lock().unwrap().take())
}

/// 文件关联：打开系统"默认应用"设置页。Windows 10+ 不允许程序静默自设默认
/// （防劫持），最后一下必须用户亲手点；绿色版无安装包写注册表，更只能走这条路。
#[tauri::command]
fn open_default_apps_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        hidden_cmd("cmd")
            .args(["/C", "start", "", "ms-settings:defaultapps"])
            .spawn()
            .map_err(|e| format!("打开默认应用设置失败: {e}"))?;
    }
    Ok(())
}

/// 文件关联：只读当前 .md 的 UserChoice ProgId（HKCU 读无害；写受 ACL 保护）。
/// reg 输出中文区是 GBK，但 ProgId 行纯 ASCII，按空白切末段即得，不怕乱码。
#[tauri::command]
fn get_md_default() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let out = hidden_cmd("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice",
                "/v",
                "ProgId",
            ])
            .output()
            .map_err(|e| format!("读默认打开方式失败: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout);
        let prog = text
            .lines()
            .find(|l| l.contains("ProgId"))
            .and_then(|l| l.split_whitespace().last())
            .map(|s| s.to_string());
        let is_tmmd = prog
            .as_ref()
            .map(|p| p.to_lowercase().contains("tmmd"))
            .unwrap_or(false);
        return Ok(serde_json::json!({ "progId": prog, "isTmmd": is_tmmd }));
    }
    #[allow(unreachable_code)]
    Ok(serde_json::json!({ "progId": null, "isTmmd": false }))
}

/// 系统「视觉效果」状态:mica/acrylic 是否有意义,以及无障碍是否开着高对比。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemEffectsState {
    pub transparency_enabled: bool,
    pub high_contrast: bool,
}

/// 读 HKCU\...\Themes\Personalize\EnableTransparency(REG_DWORD 0x0/0x1)。
/// 键或值缺失(reg 非 0 退出)返回 None → 调用方按「缺失当 true」处理。
#[cfg(target_os = "windows")]
fn read_transparency_enabled() -> Option<bool> {
    let out = hidden_cmd("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "/v",
            "EnableTransparency",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let val = text
        .lines()
        .find(|l| l.contains("EnableTransparency"))
        .and_then(|l| l.split_whitespace().last())?;
    let hex = val.trim_start_matches("0x").trim_start_matches("0X");
    u32::from_str_radix(hex, 16).ok().map(|n| n != 0)
}

/// 高对比度:SPI_GETHIGHCONTRAST + HCF_HIGHCONTRASTON(0x1);读不到当 false。
/// windows-sys 把 HIGHCONTRASTW 关在 Accessibility feature 里,这里只手写同布局结构,
/// 免得为一个只读探针多开一个编译 feature。
#[cfg(target_os = "windows")]
fn read_high_contrast() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETHIGHCONTRAST};

    #[repr(C)]
    struct HighContrast {
        cb_size: u32,
        dw_flags: u32,
        lpsz_default_scheme: *mut u16,
    }
    const HCF_HIGHCONTRASTON: u32 = 0x0000_0001;

    let mut hc = HighContrast {
        cb_size: std::mem::size_of::<HighContrast>() as u32,
        dw_flags: 0,
        lpsz_default_scheme: std::ptr::null_mut(),
    };
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            std::mem::size_of::<HighContrast>() as u32,
            &mut hc as *mut _ as *mut std::ffi::c_void,
            0,
        )
    };
    ok != 0 && (hc.dw_flags & HCF_HIGHCONTRASTON) != 0
}

/// 系统效果开关(材质回落的判断依据 + 高对比可访问性提示)。
/// 永不失败:读不到一律按「透明开、高对比关」返回。
#[tauri::command]
fn system_effects_state() -> SystemEffectsState {
    #[cfg(target_os = "windows")]
    {
        SystemEffectsState {
            transparency_enabled: read_transparency_enabled().unwrap_or(true),
            high_contrast: read_high_contrast(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        SystemEffectsState {
            transparency_enabled: true,
            high_contrast: false,
        }
    }
}

/// 上次落盘的材质键(进程内记忆):同值跳过 DWM 写操作,只在真变化时落盘。
#[cfg(target_os = "windows")]
static LAST_GLASS: std::sync::Mutex<Option<(String, u8, u8, u8, u8)>> =
    std::sync::Mutex::new(None);

/// R3b 玻璃落盘：两档彻底解耦，互不碰对方的通道。
/// 直透：TRANSPARENTGRADIENT state 2（渐变恒零）+ BlurBehind 开 + NONE + 刷 frame
/// （DISABLED 系本机一律纯黑，真屏四通道扫参定案）。
/// 磨砂：Pebrel 配方（先清 WCA 旧层 → 关 BlurBehind → 写 `DWMSBT_NONE` → 写 accent
/// state 4 + tint → `SetWindowPos + FRAMECHANGED`），绝不用 `TRANSIENTWINDOW`
/// （WebView2 是 DC 窗，新接口上去就是灰板）。mica/aero 已删，旧值兜底 acrylic。
/// 失败返回 Err，绝不 panic。
#[cfg(target_os = "windows")]
fn paint_glass(
    win: &tauri::WebviewWindow,
    acrylic: bool,
    r: u8,
    g: u8,
    b: u8,
    alpha: u8,
) -> Result<(), String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DWM_BB_ENABLE, DWM_BLURBEHIND, DWMSBT_NONE, DWMWA_SYSTEMBACKDROP_TYPE,
        DwmEnableBlurBehindWindow, DwmSetWindowAttribute,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos,
    };

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AccentPolicy {
        state: u32,
        flags: u32,
        gradient_color: u32,
        animation_id: u32,
    }
    type SetWindowCompositionAttribute =
        unsafe extern "system" fn(HWND, *mut AccentData) -> i32;
    #[repr(C)]
    struct AccentData {
        attribute: u32,
        data: *mut std::ffi::c_void,
        size: usize,
    }

    let raw: isize = win
        .hwnd()
        .map(|h| h.0 as isize)
        .map_err(|e| format!("取 HWND 失败: {e}"))?;
    let hwnd = raw as HWND;
    // WCA_ACCENT_POLICY 未进公开 SDK，和上游一样动态取 user32 地址
    let set_wca: Option<SetWindowCompositionAttribute> = unsafe {
        let user32 = GetModuleHandleA(c"user32.dll".as_ptr() as *const u8);
        if user32.is_null() {
            None
        } else {
            GetProcAddress(user32, c"SetWindowCompositionAttribute".as_ptr() as *const u8)
                .map(|f| std::mem::transmute(f))
        }
    };
    let apply_accent = |mut accent: AccentPolicy| {
        let Some(set_wca) = set_wca else { return };
        let mut data = AccentData {
            attribute: 19, // WCA_ACCENT_POLICY
            data: &mut accent as *mut _ as *mut std::ffi::c_void,
            size: std::mem::size_of::<AccentPolicy>(),
        };
        unsafe {
            set_wca(hwnd, &mut data);
        }
    };

    if !acrylic {
        // 直透独立通道：TRANSPARENTGRADIENT state 2 + BlurBehind 开 + NONE + 刷 frame。
        // 真屏四通道扫参结论：DISABLED 系（手写 accent0／三清±frame）本机一律纯黑，
        // 关 BlurBehind 同样黑；唯独 state 2 配全零渐变 + BlurBehind 开能透出壁纸。
        // 渐变色恒零（不吃 tint，直透无底色概念）；先清 accent0 洗掉磨砂 state 4 残留。
        // 磨砂通道在下面，互不干涉。
        apply_accent(AccentPolicy { state: 0, flags: 2, gradient_color: 0, animation_id: 0 });
        unsafe {
            let bb = DWM_BLURBEHIND {
                dwFlags: DWM_BB_ENABLE,
                fEnable: 1,
                hRgnBlur: std::ptr::null_mut(),
                fTransitionOnMaximized: 0,
            };
            DwmEnableBlurBehindWindow(hwnd, &bb);
            let none = DWMSBT_NONE;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_SYSTEMBACKDROP_TYPE as u32,
                &none as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&none) as u32,
            );
        }
        apply_accent(AccentPolicy {
            state: 2, // ACCENT_ENABLE_TRANSPARENTGRADIENT
            flags: 2,
            gradient_color: 0,
            animation_id: 0,
        });
        unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
        return Ok(());
    }

    // 1) 先清旧 WCA 层：反过来先写 DWMSBT，DWM 不会重算 frame，事后补清也救不回
    apply_accent(AccentPolicy { state: 0, flags: 2, gradient_color: 0, animation_id: 0 });
    // 2) 关 BlurBehind：R2 时代 aero（state 3）可能留了玻璃层，所有档位显式关
    unsafe {
        let bb = DWM_BLURBEHIND {
            dwFlags: DWM_BB_ENABLE,
            fEnable: 0,
            hRgnBlur: std::ptr::null_mut(),
            fTransitionOnMaximized: 0,
        };
        DwmEnableBlurBehindWindow(hwnd, &bb);
    }
    // 3) backdrop 永远 NONE（两档都不用 system backdrop，避免灰板）
    unsafe {
        let none = DWMSBT_NONE;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            &none as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&none) as u32,
        );
    }
    // 4) 磨砂才写 accent state 4；alpha=0 会被部分 DWM 跳过，强制保 1
    if acrylic {
        let a = alpha.max(1) as u32;
        apply_accent(AccentPolicy {
            state: 4, // ACCENT_ENABLE_ACRYLICBLURBEHIND
            flags: 0,
            gradient_color: (r as u32) | ((g as u32) << 8) | ((b as u32) << 16) | (a << 24),
            animation_id: 0,
        });
    }
    // 5) 刷非客户区 frame：没有这一步，DWM 不重读上面的属性
    unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
    Ok(())
}

/// 材质三选之三:mica(Win11 系统 backdrop)。
/// 走新接口 `DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_MAINWINDOW=2)`;
/// 接口不认(Win10 及更早)或写失败时自动回落现有 legacy acrylic 路径,不报错、不 panic。
/// 先清 legacy WCA accent 层 + 关 BlurBehind,否则磨砂残留盖在 backdrop 之上,看不到 mica。
#[cfg(target_os = "windows")]
fn paint_mica(win: &tauri::WebviewWindow, r: u8, g: u8, b: u8, alpha: u8) -> Result<(), String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DWMSBT_MAINWINDOW, DWMWA_SYSTEMBACKDROP_TYPE, DwmSetWindowAttribute,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos,
    };

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AccentPolicy3 {
        state: u32,
        flags: u32,
        gradient_color: u32,
        animation_id: u32,
    }
    type SetWca3 = unsafe extern "system" fn(HWND, *mut AccentData3) -> i32;
    #[repr(C)]
    struct AccentData3 {
        attribute: u32,
        data: *mut std::ffi::c_void,
        size: usize,
    }

    let raw: isize = win
        .hwnd()
        .map(|h| h.0 as isize)
        .map_err(|e| format!("取 HWND 失败: {e}"))?;
    let hwnd = raw as HWND;

    // 1) 清 legacy WCA accent 层(state 0 + flags 2)
    let set_wca: Option<SetWca3> = unsafe {
        let user32 = GetModuleHandleA(c"user32.dll".as_ptr() as *const u8);
        if user32.is_null() {
            None
        } else {
            GetProcAddress(user32, c"SetWindowCompositionAttribute".as_ptr() as *const u8)
                .map(|f| std::mem::transmute(f))
        }
    };
    if let Some(set_wca) = set_wca {
        let mut accent = AccentPolicy3 {
            state: 0,
            flags: 2,
            gradient_color: 0,
            animation_id: 0,
        };
        let mut data = AccentData3 {
            attribute: 19, // WCA_ACCENT_POLICY
            data: &mut accent as *mut _ as *mut std::ffi::c_void,
            size: std::mem::size_of::<AccentPolicy3>(),
        };
        unsafe {
            set_wca(hwnd, &mut data);
        }
    }
    // 2) 关 BlurBehind(旧 aero/blur 档可能留的玻璃层)
    unsafe {
        let bb = windows_sys::Win32::Graphics::Dwm::DWM_BLURBEHIND {
            dwFlags: windows_sys::Win32::Graphics::Dwm::DWM_BB_ENABLE,
            fEnable: 0,
            hRgnBlur: std::ptr::null_mut(),
            fTransitionOnMaximized: 0,
        };
        windows_sys::Win32::Graphics::Dwm::DwmEnableBlurBehindWindow(hwnd, &bb);
    }
    // 3) 写 system backdrop = MAINWINDOW(2):Win11 认;Win10 返回非 0 → 回落 acrylic
    let mica = DWMSBT_MAINWINDOW;
    let hr = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            &mica as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&mica) as u32,
        )
    };
    if hr != 0 {
        return paint_glass(win, true, r, g, b, alpha);
    }
    // 4) 刷 frame 让 DWM 重读属性
    unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
    Ok(())
}

/// R2 玻璃材质:运行时切换整窗 backdrop 材质(前端玻璃面板材质下拉驱动)。
/// material: none(直透)/ acrylic(legacy state 4 磨砂,tint 直驱)/ mica(Win11 系统 backdrop,
/// 不认则自动回落 acrylic;tint 参数在 mica 下由系统决定,仅回落时生效)。
/// 实现见 `paint_glass`(Pebrel 配方)/ `paint_mica`。dark 参数保留占位。
/// 失败返回 Err 由前端 toast,绝不 panic。
#[tauri::command]
fn set_glass_material(
    app: tauri::AppHandle,
    material: String,
    r: u8,
    g: u8,
    b: u8,
    alpha: u8,
    dark: bool,
    force: Option<bool>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = dark;
        // 同值跳过：连点不再落 DWM，只在真变化时写一次；
        // 开机/回焦重放带 force 穿透（DWM 丢状态时自愈，写了一定落）。
        {
            let key = (material.clone(), r, g, b, alpha);
            let mut last = LAST_GLASS.lock().map_err(|e| format!("材质记忆锁失败: {e}"))?;
            let same = last.as_ref() == Some(&key);
            *last = Some(key);
            if same && !force.unwrap_or(false) {
                return Ok(());
            }
        }
        let win = app
            .get_webview_window("main")
            .ok_or_else(|| "找不到主窗口".to_string())?;
        // mica(Win11 backdrop,不认则回落 acrylic)+ 未知值:统一兜底 acrylic,旧存档不报错;
        // `probe_*` 是常驻诊断通道(CDP 扫参专用,前端下拉不发这些值,正常链路不受影响)。
        // 落盘走 paint_glass / paint_mica,探针走 probe_glass。
        match material.as_str() {
            "none" => paint_glass(&win, false, r, g, b, alpha),
            "mica" => paint_mica(&win, r, g, b, alpha),
            m if m.starts_with("probe_") => probe_glass(&win, m, r, g, b, alpha),
            _ => paint_glass(&win, true, r, g, b, alpha),
        }
        .map_err(|e| format!("玻璃应用失败: {e}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, material, r, g, b, alpha, dark);
        Err("玻璃材质仅 Windows 支持".to_string())
    }
}

/// 诊断探针（常驻复用）：CDP 扫参专用，material 以 `probe_` 开头透传到这里。
/// 前端下拉只发 none/acrylic，正常链路不受影响。
/// 每个 arm 都是完整独立序列，结尾统一刷 frame，互不残留。
/// 复用流程（零污染）：debug-launch.ps1 起调试实例 → cdp-eval.mjs 调 set_glass_material 切 arm +
/// 内存覆盖 --glass(v1.8 起单一浓度;旧 --glass-base/chrome/reader/pop 已废)（不写 localStorage）→ 真屏截图对比。2026-09-16 直透即用此法定案（TG state 2）。
#[cfg(target_os = "windows")]
fn probe_glass(
    win: &tauri::WebviewWindow,
    mode: &str,
    r: u8,
    g: u8,
    b: u8,
    alpha: u8,
) -> Result<(), String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DWM_BB_ENABLE, DWM_BLURBEHIND, DWMSBT_NONE, DWMWA_SYSTEMBACKDROP_TYPE,
        DwmEnableBlurBehindWindow, DwmSetWindowAttribute,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos,
    };

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AccentPolicy2 {
        state: u32,
        flags: u32,
        gradient_color: u32,
        animation_id: u32,
    }
    type SetWca2 = unsafe extern "system" fn(HWND, *mut AccentData2) -> i32;
    #[repr(C)]
    struct AccentData2 {
        attribute: u32,
        data: *mut std::ffi::c_void,
        size: usize,
    }

    let raw: isize = win
        .hwnd()
        .map(|h| h.0 as isize)
        .map_err(|e| format!("取 HWND 失败: {e}"))?;
    let hwnd = raw as HWND;
    let set_wca: Option<SetWca2> = unsafe {
        let user32 = GetModuleHandleA(c"user32.dll".as_ptr() as *const u8);
        if user32.is_null() {
            None
        } else {
            GetProcAddress(user32, c"SetWindowCompositionAttribute".as_ptr() as *const u8)
                .map(|f| std::mem::transmute(f))
        }
    };
    let apply_accent = |accent: AccentPolicy2| {
        let Some(set_wca) = set_wca else { return };
        let mut a = accent;
        let mut data = AccentData2 {
            attribute: 19, // WCA_ACCENT_POLICY
            data: &mut a as *mut _ as *mut std::ffi::c_void,
            size: std::mem::size_of::<AccentPolicy2>(),
        };
        unsafe {
            set_wca(hwnd, &mut data);
        }
    };
    let set_backdrop_none = || unsafe {
        let none = DWMSBT_NONE;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            &none as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&none) as u32,
        );
    };
    let set_blurbehind = |on: bool| unsafe {
        let bb = DWM_BLURBEHIND {
            dwFlags: DWM_BB_ENABLE,
            fEnable: on as i32,
            hRgnBlur: std::ptr::null_mut(),
            fTransitionOnMaximized: 0,
        };
        DwmEnableBlurBehindWindow(hwnd, &bb);
    };
    let refresh_frame = || unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    };

    match mode {
        // 对照组：复刻 20e5340 手写四笔（本机实证纯黑，黑屏来源）
        "probe_accent0" => {
            apply_accent(AccentPolicy2 { state: 0, flags: 2, gradient_color: 0, animation_id: 0 });
            set_blurbehind(false);
            set_backdrop_none();
            refresh_frame();
        }
        // 三清 + 补刷 frame（本机实证纯黑，三清已死）
        "probe_clear_frame" => {
            let _ = window_vibrancy::clear_blur(win);
            let _ = window_vibrancy::clear_acrylic(win);
            let _ = window_vibrancy::clear_mica(win);
            refresh_frame();
        }
        // 透明渐变 state 2 全零渐变 + BlurBehind 开（2026-09-16 直透定案，唯一透光）
        "probe_tg" => {
            apply_accent(AccentPolicy2 { state: 0, flags: 2, gradient_color: 0, animation_id: 0 });
            set_blurbehind(true);
            set_backdrop_none();
            apply_accent(AccentPolicy2 {
                state: 2, // ACCENT_ENABLE_TRANSPARENTGRADIENT
                flags: 2,
                gradient_color: (r as u32) | ((g as u32) << 8) | ((b as u32) << 16) | ((alpha as u32) << 24),
                animation_id: 0,
            });
            refresh_frame();
        }
        // 经典 blur state 3 + BlurBehind 开（DWM 存活探针）
        "probe_blur" => {
            apply_accent(AccentPolicy2 { state: 0, flags: 2, gradient_color: 0, animation_id: 0 });
            set_backdrop_none();
            set_blurbehind(true);
            apply_accent(AccentPolicy2 { state: 3, flags: 2, gradient_color: 0, animation_id: 0 });
            refresh_frame();
        }
        // DISABLED + BlurBehind 开（无渐变纯 per-pixel 对照）
        "probe_disabled_bluron" => {
            apply_accent(AccentPolicy2 { state: 0, flags: 2, gradient_color: 0, animation_id: 0 });
            set_backdrop_none();
            set_blurbehind(true);
            refresh_frame();
        }
        // state 2 + BlurBehind 关（验证 TG 是否不需要 blur）
        "probe_tg_bluroff" => {
            apply_accent(AccentPolicy2 { state: 0, flags: 2, gradient_color: 0, animation_id: 0 });
            set_blurbehind(false);
            set_backdrop_none();
            apply_accent(AccentPolicy2 {
                state: 2, // ACCENT_ENABLE_TRANSPARENTGRADIENT
                flags: 2,
                gradient_color: 0,
                animation_id: 0,
            });
            refresh_frame();
        }
        _ => return Err(format!("未知探针: {mode}")),
    }
    Ok(())
}

/// R2-fix 诊断位：直读 DWM 当前真实 backdrop（SYSTEMBACKDROP_TYPE：0 无/1 自动/2 Mica/3 Acrylic/4 Tabbed）
/// 与沉浸深色开关。肉眼说不清时以它为准：值对但看着实 → 壁纸/焦点因素；值不对 → 调用被吞。
/// HWND 经 win.hwnd() 原始指针中转，不绑定 windows crate 版本。
#[tauri::command]
fn get_glass_state(win: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Graphics::Dwm::{
            DwmGetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_USE_IMMERSIVE_DARK_MODE,
        };
        let raw: isize = win
            .hwnd()
            .map(|h| h.0 as isize)
            .map_err(|e| format!("取 HWND 失败: {e}"))?;
        let hwnd = raw as *mut std::ffi::c_void;
        let mut backdrop: i32 = -1;
        let mut dark: i32 = -1;
        unsafe {
            let r = DwmGetWindowAttribute(
                hwnd,
                DWMWA_SYSTEMBACKDROP_TYPE as u32,
                &mut backdrop as *mut _ as _,
                4,
            );
            if r != 0 {
                return Err(format!("读 backdrop 失败: {r}"));
            }
            // 深色开关读不到不致命，记 -1 照常返回
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
                &mut dark as *mut _ as _,
                4,
            );
        }
        Ok(serde_json::json!({ "backdrop": backdrop, "darkMode": dark }))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = win;
        Err("仅 Windows 支持".to_string())
    }
}
