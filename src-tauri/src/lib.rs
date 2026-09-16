//! TMMD（透明MD） · 极速本地 Markdown 阅读器（Tauri 2，纯阅读，无工作台）

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
            // R3b 玻璃底：Pebrel 配方 legacy AccentPolicy（tint 沿用 v0.3.2 实测值），
            // 不再走 TRANSIENTWINDOW（DC 窗上是灰板）。失败只记忽略，不崩窗口。
            if let Some(win) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    let _ = paint_glass(&win, true, 20, 20, 22, 100);
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
        .expect("error while running TMMD");
}

/// 冷启动待打开路径：setup 时存入，前端 boot 后取走（取后清空，避免重复打开）
#[derive(Default)]
struct StartupPending(std::sync::Mutex<Option<String>>);

#[tauri::command]
fn pending_open(state: tauri::State<StartupPending>) -> Result<Option<String>, String> {
    Ok(state.0.lock().unwrap().take())
}

/// 上次落盘的材质键（进程内记忆）：同值跳过 DWM 写操作，只在真变化时落盘。
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

/// R2 玻璃材质：运行时切换整窗 backdrop 材质（前端玻璃面板材质下拉驱动）。
/// material: none（直透）/ acrylic（legacy state 4 磨砂，tint 直驱）。
/// 实现见 `paint_glass`（Pebrel 配方）。mica/aero 已删，旧值兜底 acrylic。
/// dark 参数保留占位。失败返回 Err 由前端 toast，绝不 panic。
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
        // mica/aero 已删 + 未知值：统一兜底 acrylic，旧存档不报错；
        // `probe_*` 是常驻诊断通道（CDP 扫参专用，前端下拉不发这些值，正常链路不受影响）。
        // 落盘走 paint_glass / 探针走 probe_glass。
        match material.as_str() {
            "none" => paint_glass(&win, false, r, g, b, alpha),
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
/// 内存覆盖 --glass-*（不写 localStorage）→ 真屏截图对比。2026-09-16 直透即用此法定案（TG state 2）。
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
