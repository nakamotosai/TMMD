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

fn cage_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root_can = root
        .canonicalize()
        .map_err(|e| format!("无法解析根目录: {e}"))?;
    let rel_pb = sanitize_rel(rel)?;
    let joined = root_can.join(&rel_pb);
    let full = if joined.exists() {
        joined
            .canonicalize()
            .map_err(|e| format!("无法解析路径: {e}"))?
    } else {
        // allow non-existing for clearer error later
        joined
    };
    if !is_under_root(&root_can, &full) {
        return Err("路径越界：不在已登记库内".into());
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
        .set_title("选择 Markdown 文件夹")
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

/// 原文件风格:编辑器里的 textarea 会把 CRLF 归一成 LF,保存时必须还原,否则"改一个字"
/// 会把整个文件的换行风格改掉(VS Code 同款回归)。BOM 按原样保留。
struct FileStyle {
    crlf: bool,
    bom: bool,
}

fn probe_style(p: &Path) -> FileStyle {
    let mut st = FileStyle {
        crlf: false,
        bom: false,
    };
    if let Ok(bytes) = fs::read(p) {
        st.bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
        let crlf = bytes.windows(2).filter(|w| *w == b"\r\n").count();
        let lf = bytes.iter().filter(|b| **b == b'\n').count();
        st.crlf = crlf > 0 && crlf * 2 >= lf; // 多数行是 CRLF 就按 CRLF 写回
    }
    st
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
        return Err(format!(
            "替换文件失败: {e}(若提示拒绝访问,通常是文件只读或被别的程序占用,关掉占用它的程序再试)"
        ));
    }
    Ok(())
}

/// 保存统一收尾:冲突检测(force=false 时对比读入指纹)→ 还换行/BOM → 原子写 → 刷新指纹。
/// 冲突以 `CONFLICT|<path>` 返回给前端,由前端决定覆盖 / 另存 / 取消(不静默覆盖)。
fn save_guarded(path: &Path, content: &str, force: bool) -> Result<(), String> {
    if !is_openable(path) {
        return Err(format!("仅支持 {} 文件", ext_hint()));
    }
    let key = cage_key(path);   // 与 remember_read 同一套归一化,否则键对不上 = 冲突检测静默失效
    if !force {
        let known = LAST_READ.lock().ok().and_then(|m| m.get(&key).copied());
        if let (Some(k), Some(now)) = (known, fingerprint(path)) {
            if k != now {
                return Err(format!("CONFLICT|{key}"));
            }
        }
    }
    let st = probe_style(path);
    let lf = content.replace("\r\n", "\n");
    let body = if st.crlf {
        lf.replace('\n', "\r\n")
    } else {
        lf
    };
    let mut bytes = Vec::with_capacity(body.len() + 3);
    if st.bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(body.as_bytes());
    write_atomic(path, &bytes)?;
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
        return Err(format!("移入回收站失败(代码 {rc},路径 {shown})"));
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
        .set_file_name(default_name.unwrap_or_else(|| "未命名.md".into()));
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
    let p = PathBuf::from(&path);
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
    let md = fs::read_to_string(&full).map_err(|e| format!("读文件失败: {e}"))?;
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

/// 打开单个 `.md` 文件（双击/拖拽/单实例转发）：校验扩展名后读内容并返回。
/// 纯只读：路径不写死囚笼（单文件浏览），仅防非 md 与超大文件。
#[tauri::command]
fn open_path(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !is_openable(p) {
        return Err(format!("仅支持 {} 文件", ext_hint()));
    }
    let meta = fs::metadata(p).map_err(|e| format!("无法读取文件: {e}"))?;
    if !meta.is_file() {
        return Err("不是文件".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("文件过大(超过 8MB)".into());
    }
    let md = fs::read_to_string(p).map_err(|e| format!("读取失败: {e}"))?;
    remember_read(p); // 记指纹:保存时用来发现"外部已改"
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
    let Ok(text) = fs::read_to_string(full) else { return };
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

/// 导出 PDF:用系统自带的 Edge/Chrome **无头**模式,把导出的独立 HTML 打成 PDF —— 零新增依赖。
/// 纪律:全程 `CREATE_NO_WINDOW`,失败只返回可读错误字符串,**绝不弹任何 UI**(用户明确要求过);
/// 生成物不出现就报错,不做"假装成功"。
#[tauri::command]
fn export_pdf(html_path: String, pdf_path: String) -> Result<String, String> {
    if !Path::new(&html_path).is_file() {
        return Err(format!("导出 HTML 不存在: {html_path}"));
    }
    let browser = find_headless_browser()?;
    let url = format!("file:///{}", html_path.replace('\\', "/").replace(' ', "%20"));
    let mut cmd = hidden_cmd(&browser);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-pdf-header-footer",
        &format!("--print-to-pdf={pdf_path}"),
        &url,
    ]);
    let status = cmd.status().map_err(|e| format!("起无头浏览器失败: {e}"))?;
    if !Path::new(&pdf_path).is_file() {
        return Err(format!(
            "PDF 未生成(浏览器退出码 {:?});可改用「打印 / 存 PDF」手动另存",
            status.code()
        ));
    }
    Ok(pdf_path)
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
    Err("找不到 Microsoft Edge / Chrome,无法直出 PDF(可改用「打印 / 存 PDF」)".into())
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
    fs::write(p, content).map_err(|e| format!("导出失败: {e}"))?;
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

/// 用系统默认程序打开任意文件/目录(ShellExecute:`cmd /C start "" "<path>"`)。
/// 用于「用默认浏览器打印导出稿」和打开导出目录;不限扩展名(区别于 open_path 的 .md 笼子)。
#[tauri::command]
fn open_any(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        hidden_cmd("cmd")
            .args(["/C", "start", "", path.as_str()])
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
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
const UPDATE_TRUSTED: [&str; 2] = [
    "https://github.com/nakamotosai/TMMD/releases/download/",
    "https://github.com/nakamotosai/TMMD/releases/latest/download/",
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

/// 版本比较:按点分段数值比(v1.8.0 > 1.7.9);非数字段当 0,不 panic。
fn version_key(v: &str) -> Vec<u64> {
    v.trim_start_matches(['v', 'V'])
        .split(['.', '-', '+'])
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect()
}

fn is_newer(remote: &str, local: &str) -> bool {
    let (a, b) = (version_key(remote), version_key(local));
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// 清单 URL 是否可信。设了 TMMD_UPDATE_ENDPOINT(测试缝)时额外放行本机地址。
fn update_url_trusted(url: &str) -> bool {
    if UPDATE_TRUSTED.iter().any(|p| url.starts_with(p)) {
        return true;
    }
    if std::env::var("TMMD_UPDATE_ENDPOINT").is_ok() {
        return url.starts_with("http://127.0.0.1") || url.starts_with("file://");
    }
    false
}

/// 检查更新。返回 None = 已是最新(或被跳过/未到节流窗口)。
/// force=true 跳过 24h 节流与"跳过此版本"(设置页手动点用)。
#[tauri::command]
fn update_check(app: tauri::AppHandle, force: Option<bool>) -> Result<Option<UpdateManifest>, String> {
    let force = force.unwrap_or(false);
    let mut st = read_update_state(&app);
    let now = now_secs();
    if !force {
        if let Some(last) = st.last_checked {
            if now.saturating_sub(last) < UPDATE_CHECK_INTERVAL {
                return Ok(None);
            }
        }
        if let Some(ra) = st.remind_after {
            if now < ra {
                return Ok(None);
            }
        }
    }
    let url = std::env::var("TMMD_UPDATE_ENDPOINT").unwrap_or_else(|_| UPDATE_MANIFEST_URL.to_string());
    let body = ureq::get(&url)
        .call()
        .map_err(|e| format!("取更新清单失败: {e}"))?
        .into_body()
        .read_to_string()
        .map_err(|e| format!("读更新清单失败: {e}"))?;
    let m: UpdateManifest =
        serde_json::from_str(&body).map_err(|e| format!("更新清单格式不对: {e}"))?;
    st.last_checked = Some(now);
    if m.sha256.len() != 64 || !m.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("更新清单里的 sha256 不合法".into());
    }
    if !update_url_trusted(&m.url) {
        return Err(format!("更新包来源不可信: {}", m.url));
    }
    if !is_newer(&m.version, env!("CARGO_PKG_VERSION")) {
        write_update_state(&app, &st);
        return Ok(None);
    }
    if !force && st.skipped_version.as_deref() == Some(m.version.as_str()) {
        write_update_state(&app, &st);
        return Ok(None);
    }
    write_update_state(&app, &st);
    Ok(Some(m))
}

/// 下载更新包到配置目录的 updates/,边下边算 SHA-256,完成后比对;不符直接删掉并报错。
/// 进度通过 `update-progress` 事件回前端({received,total})。
#[tauri::command]
fn update_download(app: tauri::AppHandle, manifest: UpdateManifest) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    if !update_url_trusted(&manifest.url) {
        return Err("更新包来源不可信".into());
    }
    if manifest.size > 512 * 1024 * 1024 {
        return Err("更新包体积异常".into());
    }
    let dir = config_path(&app, "updates")?;
    fs::create_dir_all(&dir).map_err(|e| format!("建更新目录失败: {e}"))?;
    let dest = dir.join(&manifest.asset);
    let part = dir.join(format!("{}.part", manifest.asset));
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
            "校验失败(下载内容与清单不符),已丢弃:\n期望 {}\n实际 {}",
            manifest.sha256, got
        ));
    }
    let _ = fs::remove_file(&dest);
    fs::rename(&part, &dest).map_err(|e| format!("落位失败: {e}"))?;
    let _ = app.emit(
        "update-progress",
        serde_json::json!({ "received": received, "total": total, "done": true }),
    );
    Ok(dest.to_string_lossy().to_string())
}

/// 安装:写一个临时 PS 脚本(等本进程退出 → 静默装 → 自删),隐藏窗口起它,然后由前端放行关窗。
/// 为什么不等自己退出:*安装包要覆盖正在运行的 exe*,必须先让本进程走。
#[tauri::command]
fn update_install(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("更新包不存在: {path}"));
    }
    let pid = std::process::id();
    let dir = std::env::temp_dir();
    let script = dir.join(format!("tmmd-update-{pid}.ps1"));
    let log = dir.join("tmmd-update.log");
    let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
    // .exe 直接静默装(NSIS /S);其它后缀(测试替身 / 自定义脚本)交给 cmd /c
    let launch = if path.to_ascii_lowercase().ends_with(".exe") {
        format!("Start-Process -FilePath {} -ArgumentList '/S'", q(&path))
    } else {
        format!(
            "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', {}, '/S' -WindowStyle Hidden",
            q(&path)
        )
    };
    let body = format!(
        "$ErrorActionPreference='SilentlyContinue'\r\n\
         $log = {log}\r\n\
         Add-Content -LiteralPath $log -Value ((Get-Date).ToString('s') + ' helper start pid={pid} target={path}')\r\n\
         Start-Sleep -Milliseconds 800\r\n\
         Wait-Process -Id {pid} -Timeout 120\r\n\
         Add-Content -LiteralPath $log -Value 'app exited, launching installer'\r\n\
         {launch}\r\n\
         Add-Content -LiteralPath $log -Value ('launch returned ' + $LASTEXITCODE)\r\n\
         Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force\r\n",
        log = q(&log.to_string_lossy()),
        pid = pid,
        path = path,
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
        .spawn()
        .map_err(|e| format!("起安装脚本失败: {e}"))?;
    // 记一笔:装完之后"已提示过这个版本"
    let mut st = read_update_state(&app);
    st.last_prompted = Some(env!("CARGO_PKG_VERSION").to_string());
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

// ───────────────────────── 托盘(E 类:多窗口暂不做,前端是单窗口设计) ─────────────────────────
/// 托盘:显示 / 隐藏 / 退出。
/// **退出走关窗守卫**:这里调 `win.close()` 而不是 `process::exit`,于是未保存内容照样会被拦下来问一句
/// (托盘菜单不该成为绕过守卫的后门)。
fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 TMMD", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 第二及以后实例：argv[1] = 双击/关联传进来的 .md 路径 → 转发前端渲染
            if let Some(p) = argv.get(1) {
                let _ = app.emit("open-file", p.clone());
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
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
            open_any
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
