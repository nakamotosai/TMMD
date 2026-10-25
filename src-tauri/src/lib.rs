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

/// 配置目录里的一个文件对象(app_config_dir 不存在则先建)。
fn config_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    Ok(dir.join(name))
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

/// 窗口几何(window.json,**逻辑像素**,与缩放无关)。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WindowState {
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
        w,
        h,
        x: wx + (ww - w) / 2.0,
        y: wy + (wh - h) / 2.0,
    }
}

/// 启动:还原上次几何(必须完整落在当前显示器工作区内),否则按工作区默认尺寸居中。
/// 全程 **逻辑像素**(与 monitor.scale_factor 配套;见 work_area_logical 的真机注释)。
fn apply_initial_window(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let (wx, wy, ww, wh) = work_area_logical(&win);
    let st = match read_window_state(app) {
        Some(s) if window_state_fits(&s, wx, wy, ww, wh) => s,
        _ => default_window_state(wx, wy, ww, wh),
    };
    let _ = win.set_size(tauri::LogicalSize::new(st.w, st.h));
    let _ = win.set_position(tauri::LogicalPosition::new(st.x, st.y));
}

/// 归一化当前几何为**逻辑像素**;最大化/最小化/全屏期间返回 None
/// (那些尺寸不是用户意图,存了会污染下次启动)。
fn current_window_state(win: &tauri::Window) -> Option<WindowState> {
    if win.is_maximized().unwrap_or(false)
        || win.is_minimized().unwrap_or(false)
        || win.is_fullscreen().unwrap_or(false)
    {
        return None;
    }
    let sf = match win.scale_factor() {
        Ok(s) if s > 0.0 => s,
        _ => return None,
    };
    let size = win.inner_size().ok()?;
    let pos = win.outer_position().ok()?;
    let st = WindowState {
        w: size.width as f64 / sf,
        h: size.height as f64 / sf,
        x: pos.x as f64 / sf,
        y: pos.y as f64 / sf,
    };
    (st.w >= 1.0 && st.h >= 1.0).then_some(st)
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
    for (idx, line) in text.lines().enumerate() {
        if hits.len() >= limit {
            return;
        }
        if line.len() < needle.len() || !line.to_lowercase().contains(needle) {
            continue;
        }
        hits.push(SearchHit {
            path: abs.clone(),
            rel: rel.clone(),
            root: root_s.clone(),
            line: (idx + 1) as u32,
            text: truncate_chars(line.trim(), SEARCH_TEXT_MAX),
        });
    }
}

/// 库级全文搜索:扫 roots.json 全部根(is_doc + skip_dir_name 过滤,>8MB 文件跳过,
/// 非 UTF-8 读不出就跳过),大小写不敏感子串匹配,命中即收,到 limit(默认 200)提前结束。
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
        for r in roots {
            if hits.len() >= cap {
                break;
            }
            let root = PathBuf::from(&r.path);
            search_dir(&root, &root, &needle, cap, 0, &mut hits);
        }
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
        std::process::Command::new("cmd")
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
            // 尺寸自适应:还原上次几何(须落在当前显示器工作区内),否则工作区 88% 居中;
            // 必须在 paint_glass 之前,避免按旧尺寸先算一遍绘制。
            apply_initial_window(app.handle());
            // R3b 玻璃底:Pebrel 配方 legacy AccentPolicy(tint 沿用 v0.3.2 实测值),
            // 不再走 TRANSIENTWINDOW(DC 窗上是灰板)。失败只记忽略,不崩窗口。
            if let Some(win) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    let _ = paint_glass(&win, true, 20, 20, 22, 100);
                }
            }
            // 几何落盘去抖线程:Resized/Moved 只投递,静默 500ms 后才写 window.json
            spawn_window_save_worker(app.handle().clone());
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
        std::process::Command::new("cmd")
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
        let out = std::process::Command::new("reg")
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
    let out = std::process::Command::new("reg")
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
