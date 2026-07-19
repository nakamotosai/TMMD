fn main() {
    // Register custom commands so tauri-build emits allow-* / deny-* ACL permissions.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "desktop_info",
                "pick_folder",
                "list_md_tree",
                "read_text",
                "load_roots",
                "save_roots",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
