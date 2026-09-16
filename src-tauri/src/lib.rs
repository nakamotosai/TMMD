//! Sai Reader · 极速本地 Markdown 阅读器（Tauri 2，纯阅读，无工作台）

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{Emitter, Manager};

const MAX_FILES: usize = 5000;
const MAX_DEPTH: usize = 12;
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const ROOTS_FILE: &str = "roots.json";

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

fn is_doc(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".mdx")
        || lower.ends_with(".html")
        || lower.ends_with(".htm")
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

fn roots_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    Ok(dir.join(ROOTS_FILE))
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

/// 写回文件（文件夹浏览模式）：囚笼内校验 + 大小上限，与 read_text 对称。
#[tauri::command]
fn write_text(root: String, rel: String, content: String) -> Result<(), String> {
    if content.len() as u64 > MAX_BYTES {
        return Err(format!("内容过大（超过 {}MB）", MAX_BYTES / 1024 / 1024));
    }
    let root_pb = PathBuf::from(&root);
    let full = cage_join(&root_pb, &rel)?;
    fs::write(&full, content).map_err(|e| format!("写文件失败: {e}"))
}

/// 写回单文件（双击/拖拽模式）：与 open_path 相同扩展名校验。
#[tauri::command]
fn save_path(path: String, content: String) -> Result<(), String> {
    if content.len() as u64 > MAX_BYTES {
        return Err(format!("内容过大（超过 {}MB）", MAX_BYTES / 1024 / 1024));
    }
    let p = Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "md" && ext != "markdown" {
        return Err("仅支持 .md / .markdown 文件".into());
    }
    fs::write(p, content).map_err(|e| format!("写文件失败: {e}"))
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
    fs::read_to_string(&full).map_err(|e| format!("读文件失败: {e}"))
}

#[tauri::command]
fn load_roots(app: tauri::AppHandle) -> Result<Vec<RootMeta>, String> {
    let p = roots_path(&app)?;
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
        .add_filter("Markdown", &["md", "markdown"])
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
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "md" && ext != "markdown" {
        return Err("仅支持 .md / .markdown 文件".into());
    }
    let meta = fs::metadata(p).map_err(|e| format!("无法读取文件: {e}"))?;
    if !meta.is_file() {
        return Err("不是文件".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("文件过大（超过 8MB）".into());
    }
    fs::read_to_string(p).map_err(|e| format!("读取失败: {e}"))
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
            // 冷启动（首个进程）：argv[1] 可能带着 .md 路径，先存起来等前端就绪再取
            let first = std::env::args().nth(1);
            *app.state::<StartupPending>().0.lock().unwrap() = first;
            // W1 玻璃后端材质：透明窗 + 亚克力底（tint 沿用 v0.3.2 实测值）。
            // CSS 仍全实色，视觉零变化，分层留到 W2；旧坑（透明窗首屏黑/合成层，
            // progress v1.1.3/v1.1.1）由 W4 双通道验收覆盖。材质失败只记忽略，不崩窗口。
            // 玻璃后端材质：透明窗 + 亚克力底（acrylic=Ok 已实证，见 progress W5）。
            if let Some(win) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    let _ = window_vibrancy::apply_acrylic(&win, Some((20, 20, 22, 100)));
                }
            }
            Ok(())
        })
        .manage(StartupPending::default())
        .invoke_handler(tauri::generate_handler![
            desktop_info,
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
            get_glass_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sai Reader");
}

/// 冷启动待打开路径：setup 时存入，前端 boot 后取走（取后清空，避免重复打开）
#[derive(Default)]
struct StartupPending(std::sync::Mutex<Option<String>>);

#[tauri::command]
fn pending_open(state: tauri::State<StartupPending>) -> Result<Option<String>, String> {
    Ok(state.0.lock().unwrap().take())
}

/// 上次落盘的材质键（进程内记忆）：同值跳过 DWM 写操作。
/// 本机实证（2026-09-16，真机截图闭环）：首写生效，反复写 SYSTEMBACKDROP_TYPE 会把渲染致盲且不可逆
/// （DWM 读值正常、页全透、屏实色， GPU 空闲也救不回）；只有真变化时才值得落盘。
#[cfg(target_os = "windows")]
static LAST_GLASS: std::sync::Mutex<Option<(String, u8, u8, u8, u8)>> =
    std::sync::Mutex::new(None);

/// R2 玻璃材质：运行时切换整窗 backdrop 材质（前端玻璃面板材质下拉驱动）。
/// material: none（DWM 不画材质，直透 + 网页层自身半透明）/ acrylic（高开销，r/g/b/alpha 为 tint，可透后方窗口）。
/// aero 已删：SWCA blur-behind 在 Win11 上是废弃通道（纯黑 + 拖动抖，库文档自认无解）。
/// mica 已删：本机三轮实证不画（DWM 值钉到 2、网页层全透、屏上仍是均匀实色，壁纸是彩色大理石仍无纹理），
///   旧存档 mica/aero 一律兜底 acrylic。clear_mica 保留在清理序列里，专清 DWM 里残留的 MAINWINDOW。
/// dark 参数保留占位（以后材质回归再用）。失败返回 Err 由前端 toast，绝不 panic。
#[tauri::command]
fn set_glass_material(
    app: tauri::AppHandle,
    material: String,
    r: u8,
    g: u8,
    b: u8,
    alpha: u8,
    dark: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_acrylic, clear_acrylic, clear_blur, clear_mica};
        let _ = dark;
        // 同值跳过：重放/连点不再落 DWM，只在 none↔acrylic 真切换时写一次
        {
            let key = (material.clone(), r, g, b, alpha);
            let mut last = LAST_GLASS.lock().map_err(|e| format!("材质记忆锁失败: {e}"))?;
            if last.as_ref() == Some(&key) {
                return Ok(());
            }
            *last = Some(key);
        }
        let win = app
            .get_webview_window("main")
            .ok_or_else(|| "找不到主窗口".to_string())?;
        // 先清后设：DWMWA_SYSTEMBACKDROP_TYPE 常驻，叠写会造成双 backdrop 冲突
        // （顶栏重影：拖动时正常、松手恢复，2026-09-16 实证）。每次先把三者清干净。
        let _ = clear_blur(&win);
        let _ = clear_acrylic(&win);
        let _ = clear_mica(&win);
        match material.as_str() {
            "none" => {
                // 上面已全清，这里无需再做；保留分支语义
                Ok(())
            }
            // mica/aero 已删 + 未知值：统一兜底 acrylic，旧存档不报错
            _ => apply_acrylic(&win, Some((r, g, b, alpha)))
                .map_err(|e| format!("亚克力应用失败: {e}")),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, material, r, g, b, alpha, dark);
        Err("玻璃材质仅 Windows 支持".to_string())
    }
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
