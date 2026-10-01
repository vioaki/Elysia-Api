fn main() {
    println!(
        "cargo:rustc-env=ELYSIA_TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap()
    );
    const COMMANDS: &[&str] = &[
        "desktop_state",
        "start_backend",
        "stop_backend",
        "set_port",
        "choose_data_directory",
        "open_data_directory",
        "open_log",
        "copy_api_address",
        "copy_panel_token",
        "check_updates",
        "install_update",
        "cancel_update",
        "set_autostart",
        "show_panel",
        "quit_app",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("Tauri build failed");
}
