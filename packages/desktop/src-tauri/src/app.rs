use crate::backend::{self, Backend, PanelConfig};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    data_dir: Option<PathBuf>,
    legacy_login_checked: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateView {
    status: String,
    version: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    message: String,
}

impl Default for UpdateView {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            version: None,
            downloaded: 0,
            total: None,
            message: "启动时及每 24 小时检查更新。".into(),
        }
    }
}

#[derive(Default)]
struct Updates {
    view: UpdateView,
    available: Option<Update>,
    cancel: Option<Arc<tokio::sync::Notify>>,
    cancel_requested: bool,
}

impl Updates {
    fn begin_install(&mut self, quitting: bool) -> bool {
        self.cancel = None;
        if quitting || self.cancel_requested {
            self.view.status = "available".into();
            self.view.message = "已取消下载，当前服务未受影响。".into();
            false
        } else {
            self.view.status = "installing".into();
            self.view.message = "验签完成，正在停止后端并安装…".into();
            true
        }
    }
}

// ponytail: serialize local backend management; split locks if concurrent management ever matters.
struct Desktop {
    backend: Mutex<Backend>,
    updates: Mutex<Updates>,
    update_busy: AtomicBool,
    first_run: AtomicBool,
    background: AtomicBool,
    quitting: AtomicBool,
    exit_ready: AtomicBool,
    has_tray: AtomicBool,
    legacy_login_blocked: AtomicBool,
    preferences_path: PathBuf,
    testing: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DesktopView {
    status: String,
    message: String,
    has_child: bool,
    api_address: Option<String>,
    port: u16,
    data_dir: String,
    version: String,
    autostart: bool,
    first_run: bool,
    update: UpdateView,
}

#[tauri::command]
fn desktop_state(app: AppHandle) -> DesktopView {
    let state = app.state::<Desktop>();
    let backend = state.backend.lock().unwrap();
    let update = state.updates.lock().unwrap().view.clone();
    DesktopView {
        status: backend.status.clone(),
        message: backend.message.clone(),
        has_child: backend.has_child(),
        api_address: Some(backend.config.api_address()),
        port: backend.config.port,
        data_dir: backend.data_dir.to_string_lossy().into_owned(),
        version: app.package_info().version.to_string(),
        autostart: !state.testing && app.autolaunch().is_enabled().unwrap_or(false),
        first_run: state.first_run.load(Ordering::SeqCst),
        update,
    }
}

fn publish(app: &AppHandle) {
    let view = desktop_state(app.clone());
    let _ = app.emit_to("control", "desktop-state", view);
}

fn management_allowed(state: &Desktop) -> Result<(), String> {
    if state.quitting.load(Ordering::SeqCst)
        || state.updates.lock().unwrap().view.status == "installing"
    {
        Err("应用正在退出或安装更新，请稍后。".into())
    } else {
        Ok(())
    }
}

fn save_preferences(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Desktop>();
    let preferences = Preferences {
        data_dir: Some(state.backend.lock().unwrap().data_dir.clone()),
        legacy_login_checked: !state.legacy_login_blocked.load(Ordering::SeqCst),
    };
    let path = &state.preferences_path;
    fs::create_dir_all(path.parent().ok_or("偏好目录无效。")?).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&preferences).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

fn show_window(app: &AppHandle) -> Result<(), String> {
    app.state::<Desktop>()
        .background
        .store(false, Ordering::SeqCst);
    let window = app
        .get_webview_window("control")
        .ok_or("应用窗口不可用。")?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

fn show_control(app: &AppHandle) {
    let _ = show_window(app);
    let _ = app.emit_to("control", "desktop-settings", ());
    publish(app);
}

#[tauri::command]
fn show_panel(app: AppHandle) -> Result<(), String> {
    show_window(&app)
}

fn app_navigation(url: &tauri::Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && matches!(
            (url.scheme(), url.host_str()),
            ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
        )
}

fn build_window(app: &AppHandle) -> tauri::Result<()> {
    let navigation_app = app.clone();
    let new_window_app = app.clone();
    let download_app = app.clone();
    WebviewWindowBuilder::new(app, "control", WebviewUrl::App("ui/index.html".into()))
        .title("Elysia API")
        .inner_size(1200.0, 820.0)
        .min_inner_size(760.0, 560.0)
        .visible(false)
        .on_navigation(move |url| {
            if app_navigation(url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                let _ = navigation_app.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .on_new_window(move |url, _| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = new_window_app.opener().open_url(url.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(move |_, event| {
            if let tauri::webview::DownloadEvent::Finished { success, path, .. } = event {
                if success {
                    download_app
                        .state::<Desktop>()
                        .backend
                        .lock()
                        .unwrap()
                        .log(&format!("Export saved: {path:?}"));
                } else {
                    report(&download_app, "文件导出失败，请重试。".into());
                }
            }
            true
        })
        .build()?;
    Ok(())
}

#[tauri::command]
async fn start_backend(app: AppHandle) -> Result<(), String> {
    if app.state::<Desktop>().updates.lock().unwrap().view.status == "installing" {
        return Err("正在安装更新，请稍后。".into());
    }
    save_preferences(&app)?;
    app.state::<Desktop>()
        .first_run
        .store(false, Ordering::SeqCst);
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<Desktop>();
        let mut backend = state.backend.lock().unwrap();
        management_allowed(&state)?;
        backend.start(true)
    })
    .await
    .map_err(|e| e.to_string())?;
    publish(&app);
    result
}

async fn stop_owned_backend(app: &AppHandle, allow_kill: bool) -> Result<(), String> {
    {
        let state = app.state::<Desktop>();
        let mut backend = state.backend.lock().unwrap();
        backend.status = "stopping".into();
        backend.message = "正在停止服务并保存用量记录…".into();
    }
    publish(app);
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<Desktop>();
        let mut backend = state.backend.lock().unwrap();
        if allow_kill && state.updates.lock().unwrap().view.status == "installing" {
            return Err("安装更新期间不能手动终止后端。".into());
        }
        backend.stop(allow_kill)
    })
    .await
    .map_err(|e| e.to_string())?;
    publish(app);
    result
}

#[tauri::command]
async fn stop_backend(app: AppHandle) -> Result<(), String> {
    show_control(&app);
    stop_owned_backend(&app, true).await
}

#[tauri::command]
fn set_port(app: AppHandle, port: u16) -> Result<(), String> {
    let state = app.state::<Desktop>();
    let mut backend = state.backend.lock().unwrap();
    management_allowed(&state)?;
    if backend.has_child() {
        return Err("请先停止服务，再修改端口。".into());
    }
    backend::write_port(&backend.data_dir, port)?;
    backend.config = PanelConfig::read(&backend.data_dir)?;
    drop(backend);
    publish(&app);
    Ok(())
}

#[tauri::command]
async fn choose_data_directory(app: AppHandle) -> Result<(), String> {
    if app.state::<Desktop>().backend.lock().unwrap().has_child() {
        return Err("请先停止服务，再选择目录。".into());
    }
    let handle = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("选择现有 Elysia API 数据目录（含 config.json）")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(selected) = selected else {
        return Ok(());
    };
    let dir = selected.into_path().map_err(|e| e.to_string())?;
    if !dir.join("config.json").is_file() {
        return Err("所选目录缺少 config.json，请选择原数据目录。".into());
    }
    let config = PanelConfig::read(&dir)?;
    {
        let state = app.state::<Desktop>();
        let mut backend = state.backend.lock().unwrap();
        management_allowed(&state)?;
        if backend.has_child() {
            return Err("服务已启动，请先停止。".into());
        }
        backend.data_dir = dir;
        backend.config = config;
        backend.message = "已选择原数据目录，点击启动服务。".into();
    }
    save_preferences(&app)?;
    publish(&app);
    Ok(())
}

#[tauri::command]
fn open_data_directory(app: AppHandle) -> Result<(), String> {
    let dir = app
        .state::<Desktop>()
        .backend
        .lock()
        .unwrap()
        .data_dir
        .clone();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_log(app: AppHandle) -> Result<(), String> {
    let path = app.state::<Desktop>().backend.lock().unwrap().log_path();
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_api_address(app: AppHandle) -> Result<(), String> {
    let address = app
        .state::<Desktop>()
        .backend
        .lock()
        .unwrap()
        .config
        .api_address();
    app.clipboard()
        .write_text(address)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_panel_token(app: AppHandle) -> Result<(), String> {
    let dir = app
        .state::<Desktop>()
        .backend
        .lock()
        .unwrap()
        .data_dir
        .clone();
    let token = PanelConfig::read(&dir)?.panel_access_token;
    if token.is_empty() {
        return Err("请先启动后端生成面板令牌。".into());
    }
    app.clipboard().write_text(token).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<Desktop>();
    if state.testing {
        return Err("隔离验收模式不会修改系统开机启动项。".into());
    }
    if state.legacy_login_blocked.load(Ordering::SeqCst) {
        #[cfg(target_os = "macos")]
        let _ = app.opener().open_url(
            "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
            None::<&str>,
        );
        return Err("旧开机启动项未能移除，请在系统登录项中关闭它，重启应用后再启用。".into());
    }
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|e| e.to_string())?;
    publish(&app);
    Ok(())
}

fn update_error(app: &AppHandle, error: String) {
    {
        let state = app.state::<Desktop>();
        let mut updates = state.updates.lock().unwrap();
        updates.view.status = "error".into();
        updates.view.message = error.clone();
        updates.cancel = None;
        state.update_busy.store(false, Ordering::SeqCst);
    }
    app.state::<Desktop>()
        .backend
        .lock()
        .unwrap()
        .log(&format!("Update: {error}"));
    publish(app);
}

async fn check_for_updates(app: AppHandle, silent: bool) -> Result<(), String> {
    if app
        .state::<Desktop>()
        .update_busy
        .swap(true, Ordering::SeqCst)
    {
        return Err("更新操作正在进行，请稍后。".into());
    }
    {
        let state = app.state::<Desktop>();
        let mut updates = state.updates.lock().unwrap();
        updates.view.status = "checking".into();
        updates.view.message = "正在检查更新…".into();
    }
    publish(&app);
    let result = async {
        app.updater_builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    match result {
        Ok(update) => {
            let found = update.is_some();
            {
                let state = app.state::<Desktop>();
                let mut updates = state.updates.lock().unwrap();
                updates.view.version = update.as_ref().map(|u| u.version.clone());
                updates.view.status = if found { "available" } else { "up_to_date" }.into();
                updates.view.message = update
                    .as_ref()
                    .map(|u| format!("可以更新到 {}。", u.version))
                    .unwrap_or_else(|| "已是最新版本。".into());
                updates.available = update;
                state.update_busy.store(false, Ordering::SeqCst);
            }
            publish(&app);
            if found || !silent {
                show_control(&app);
            }
            Ok(())
        }
        Err(error) => {
            update_error(&app, format!("检查更新失败：{error}"));
            if !silent {
                show_control(&app);
            }
            Err(error)
        }
    }
}

#[tauri::command]
async fn check_updates(app: AppHandle) -> Result<(), String> {
    check_for_updates(app, false).await
}

#[tauri::command]
fn cancel_update(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Desktop>();
    let mut updates = state.updates.lock().unwrap();
    if let Some(cancel) = &updates.cancel {
        cancel.notify_one();
        updates.cancel_requested = true;
        Ok(())
    } else {
        Err("当前更新阶段无法取消。".into())
    }
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let mut update = app
        .state::<Desktop>()
        .updates
        .lock()
        .unwrap()
        .available
        .clone()
        .ok_or("请先检查更新。")?;
    update.timeout = Some(Duration::from_secs(600));
    if app
        .state::<Desktop>()
        .update_busy
        .swap(true, Ordering::SeqCst)
    {
        return Err("更新操作正在进行，请稍后。".into());
    }
    show_control(&app);
    let handle = app.clone();
    let version = update.version.clone();
    let accepted = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = handle
            .dialog()
            .message(format!(
                "下载并安装 {version}？\n下载与验签完成后会暂停本机 API，保存用量记录并重启应用。"
            ))
            .title("Elysia API 更新")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "下载并安装".into(),
                "稍后".into(),
            ));
        if let Some(control) = handle.get_webview_window("control") {
            dialog = dialog.parent(&control);
        }
        dialog.blocking_show()
    })
    .await
    .map_err(|e| e.to_string())?;
    if !accepted {
        app.state::<Desktop>()
            .update_busy
            .store(false, Ordering::SeqCst);
        return Ok(());
    }
    let cancel = Arc::new(tokio::sync::Notify::new());
    {
        let state = app.state::<Desktop>();
        let mut updates = state.updates.lock().unwrap();
        if state.quitting.load(Ordering::SeqCst) {
            state.update_busy.store(false, Ordering::SeqCst);
            return Ok(());
        }
        updates.cancel = Some(cancel.clone());
        updates.cancel_requested = false;
        updates.view.status = "downloading".into();
        updates.view.downloaded = 0;
        updates.view.total = None;
        updates.view.message = "正在下载；当前服务继续运行。".into();
    }
    publish(&app);
    let progress_app = app.clone();
    let finish_app = app.clone();
    let mut last_progress = Instant::now();
    let downloaded = tokio::select! {
        result = update.download(move |chunk, total| {
            { let state = progress_app.state::<Desktop>(); let mut updates = state.updates.lock().unwrap(); updates.view.downloaded += chunk as u64; updates.view.total = total; }
            if last_progress.elapsed() >= Duration::from_millis(150) { last_progress = Instant::now(); publish(&progress_app); }
        }, move || {
            { let state = finish_app.state::<Desktop>(); let mut updates = state.updates.lock().unwrap(); updates.view.status = "verifying".into(); updates.view.message = "正在验证更新签名…".into(); }
            publish(&finish_app);
        }) => result.map_err(|e| e.to_string()),
        _ = cancel.notified() => {
            { let state = app.state::<Desktop>(); let mut updates = state.updates.lock().unwrap(); updates.cancel = None; updates.view.status = "available".into(); updates.view.message = "已取消下载，当前服务未受影响。".into(); state.update_busy.store(false, Ordering::SeqCst); }
            publish(&app); return Ok(());
        }
    };
    let bytes = match downloaded {
        Ok(bytes) => bytes,
        Err(error) => {
            update_error(&app, format!("下载或验签失败：{error}"));
            return Err(error);
        }
    };
    let begin_install = {
        let state = app.state::<Desktop>();
        let mut updates = state.updates.lock().unwrap();
        let begin_install = updates.begin_install(state.quitting.load(Ordering::SeqCst));
        if !begin_install {
            state.update_busy.store(false, Ordering::SeqCst);
        }
        begin_install
    };
    publish(&app);
    if !begin_install {
        return Ok(());
    }
    let was_running = app.state::<Desktop>().backend.lock().unwrap().has_child();
    if let Err(error) = stop_owned_backend(&app, false).await {
        update_error(&app, error.clone());
        return Err(error);
    }
    // The Windows installer exits the app itself. The owned backend is already drained.
    app.state::<Desktop>()
        .quitting
        .store(true, Ordering::SeqCst);
    let handle = app.clone();
    #[cfg(windows)]
    let error_log = app.state::<Desktop>().backend.lock().unwrap().log_path();
    let install = tauri::async_runtime::spawn_blocking(move || {
        let release = handle
            .state::<Desktop>()
            .updates
            .lock()
            .unwrap()
            .available
            .clone()
            .ok_or("更新信息已失效。")?;
        #[cfg(target_os = "macos")]
        {
            let current = tauri_plugin_updater::extract_path_from_executable(
                &std::env::current_exe().map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            crate::macos_update::install_with_backup(&current, || {
                release.install(bytes).map_err(|e| e.to_string())
            })
        }
        #[cfg(not(target_os = "macos"))]
        release.install(bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(error) = install {
        #[cfg(windows)]
        {
            use std::io::Write;
            if let Ok(mut log) = std::fs::OpenOptions::new().append(true).open(error_log) {
                let _ = writeln!(
                    log,
                    "[desktop] Update installation failed; restarting the old app: {error}"
                );
            }
            // The Windows installer may have cleaned Tauri resources before failing.
            app.state::<Desktop>()
                .exit_ready
                .store(true, Ordering::SeqCst);
            app.restart();
        }
        #[cfg(not(windows))]
        {
            app.state::<Desktop>()
                .quitting
                .store(false, Ordering::SeqCst);
            update_error(&app, format!("安装失败：{error}"));
            if was_running {
                let _ = start_backend(app.clone()).await;
            }
            return Err(error);
        }
    }
    app.state::<Desktop>()
        .exit_ready
        .store(true, Ordering::SeqCst);
    app.restart();
}

fn request_quit(app: AppHandle) {
    {
        let state = app.state::<Desktop>();
        let updates = state.updates.lock().unwrap();
        if updates.view.status == "installing" || state.quitting.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(cancel) = &updates.cancel {
            cancel.notify_one();
        }
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = stop_owned_backend(&app, true).await {
            app.state::<Desktop>()
                .quitting
                .store(false, Ordering::SeqCst);
            update_error(&app, error);
            show_control(&app);
            return;
        }
        app.state::<Desktop>()
            .exit_ready
            .store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    request_quit(app);
}

fn menu_action(app: &AppHandle, id: &str) {
    let handle = app.clone();
    match id {
        "show" => {
            if let Err(e) = show_panel(handle) {
                report(app, e);
            }
        }
        "control" => show_control(app),
        "start" => {
            show_control(app);
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_backend(handle.clone()).await {
                    report(&handle, e);
                }
            });
        }
        "stop" => {
            tauri::async_runtime::spawn(async move {
                if let Err(e) = stop_backend(handle.clone()).await {
                    report(&handle, e);
                }
            });
        }
        "copy-api" => {
            if let Err(e) = copy_api_address(handle) {
                report(app, e);
            }
        }
        "copy-token" => {
            if let Err(e) = copy_panel_token(handle) {
                report(app, e);
            }
        }
        "data" => {
            if let Err(e) = open_data_directory(handle) {
                report(app, e);
            }
        }
        "log" => {
            if let Err(e) = open_log(handle) {
                report(app, e);
            }
        }
        "update" => {
            tauri::async_runtime::spawn(async move {
                let _ = check_updates(handle).await;
            });
        }
        "quit" => request_quit(handle),
        _ => {}
    }
}

fn report(app: &AppHandle, error: String) {
    app.dialog().message(error).title("Elysia API").show(|_| {});
}

fn build_menus(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    for (id, text) in [
        ("show", "显示主窗口"),
        ("control", "应用设置"),
        ("start", "启动服务"),
        ("stop", "停止服务"),
        ("copy-api", "复制 API 地址"),
        ("copy-token", "复制面板令牌"),
        ("data", "打开数据目录"),
        ("log", "查看运行日志"),
        ("update", "检查更新"),
        ("quit", "退出 Elysia API"),
    ] {
        menu.append(&MenuItem::with_id(app, id, text, true, None::<&str>)?)?;
    }
    let tray = TrayIconBuilder::with_id("elysia")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Elysia API")
        .menu(&menu)
        .on_menu_event(|app, event| menu_action(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                let _ = show_panel(tray.app_handle().clone());
            }
        })
        .build(app);
    #[cfg(target_os = "linux")]
    let tray_supported = std::process::Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--timeout",
            "2",
            "--dest",
            "org.kde.StatusNotifierWatcher",
            "--object-path",
            "/StatusNotifierWatcher",
            "--method",
            "org.freedesktop.DBus.Properties.Get",
            "org.kde.StatusNotifierWatcher",
            "IsStatusNotifierHostRegistered",
        ])
        .output()
        .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("true"));
    #[cfg(not(target_os = "linux"))]
    let tray_supported = true;
    app.state::<Desktop>()
        .has_tray
        .store(tray.is_ok() && tray_supported, Ordering::SeqCst);
    if let Err(error) = tray {
        app.state::<Desktop>()
            .backend
            .lock()
            .unwrap()
            .log(&format!("Tray unavailable, window will minimize: {error}"));
    }
    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            "Elysia API",
            true,
            &[
                &MenuItem::with_id(app, "control", "应用设置", true, Some("CmdOrCtrl+,"))?,
                &MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?,
                &MenuItem::with_id(app, "quit", "退出 Elysia API", true, Some("CmdOrCtrl+Q"))?,
            ],
        )?;
        let edit = Submenu::with_items(
            app,
            "编辑",
            true,
            &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ],
        )?;
        app.set_menu(Menu::with_items(app, &[&app_menu, &edit])?)?;
        app.on_menu_event(|app, event| menu_action(app, event.id.as_ref()));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn reconcile_legacy_login() -> Result<bool, String> {
    use objc2::{
        msg_send,
        runtime::{AnyClass, AnyObject, Bool},
    };
    use std::process::Command;
    let mut enabled = Command::new("/usr/bin/defaults")
        .args([
            "read",
            "dev.pinkelysiadev.ElysiaApi",
            "ElysiaApi.launchAtLogin",
        ])
        .output()
        .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "1");
    // Resolve dynamically: SMAppService does not exist on the supported macOS 12.
    if let Some(class) = AnyClass::get(c"SMAppService") {
        unsafe {
            let service: *mut AnyObject = msg_send![class, mainAppService];
            let status: usize = msg_send![service, status];
            enabled = matches!(status, 1 | 2);
            if matches!(status, 1 | 2) {
                let success: Bool = msg_send![service, unregisterAndReturnError: std::ptr::null_mut::<*mut AnyObject>()];
                if !success.as_bool() {
                    return Err("请先在系统登录项中关闭旧 Elysia API，再启用新开机启动。".into());
                }
            }
        }
    }
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path =
        PathBuf::from(home).join("Library/LaunchAgents/dev.pinkelysiadev.ElysiaApi.login.plist");
    if path.is_file() {
        let uid = Command::new("/usr/bin/id")
            .arg("-u")
            .output()
            .map_err(|e| e.to_string())?;
        let service = format!(
            "gui/{}/dev.pinkelysiadev.ElysiaApi.login",
            String::from_utf8_lossy(&uid.stdout).trim()
        );
        let loaded = Command::new("/bin/launchctl")
            .args(["print", &service])
            .output()
            .map_err(|e| e.to_string())?
            .status
            .success();
        if loaded
            && !Command::new("/bin/launchctl")
                .args(["bootout", &service])
                .output()
                .map_err(|e| e.to_string())?
                .status
                .success()
        {
            return Err("无法注销旧开机启动项，请在系统设置中处理。".into());
        }
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(enabled)
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args
                .iter()
                .any(|a| matches!(a.as_str(), "--background" | "--login"))
            {
                let _ = show_panel(app.clone());
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            desktop_state,
            start_backend,
            stop_backend,
            set_port,
            choose_data_directory,
            open_data_directory,
            open_log,
            copy_api_address,
            copy_panel_token,
            check_updates,
            install_update,
            cancel_update,
            set_autostart,
            show_panel,
            quit_app
        ])
        .setup(|app| {
            let test_root = if cfg!(debug_assertions) {
                std::env::var_os("ELYSIA_DESKTOP_TEST_ROOT").map(PathBuf::from)
            } else {
                None
            };
            let preferences_path = test_root
                .as_ref()
                .map(|p| p.join("desktop.json"))
                .unwrap_or(app.path().app_config_dir()?.join("desktop.json"));
            let preferences: Option<Preferences> = fs::read(&preferences_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok());
            let first_run = !cfg!(target_os = "macos") && preferences.is_none();
            let dir = preferences
                .as_ref()
                .and_then(|p| p.data_dir.clone())
                .unwrap_or(
                    test_root
                        .as_ref()
                        .map(|p| p.join("data"))
                        .unwrap_or(backend::default_data_dir()?),
                );
            let mut backend = Backend::new(dir)?;
            if let Ok(config) = PanelConfig::read(&backend.data_dir) {
                backend.config = config;
            }
            let background =
                std::env::args().any(|a| matches!(a.as_str(), "--background" | "--login"));
            app.manage(Desktop {
                backend: Mutex::new(backend),
                updates: Mutex::new(Updates::default()),
                update_busy: AtomicBool::new(false),
                first_run: AtomicBool::new(first_run),
                background: AtomicBool::new(background),
                quitting: AtomicBool::new(false),
                exit_ready: AtomicBool::new(false),
                has_tray: AtomicBool::new(false),
                legacy_login_blocked: AtomicBool::new(false),
                preferences_path,
                testing: test_root.is_some(),
            });
            build_window(app.handle())?;
            build_menus(app.handle())?;
            #[cfg(target_os = "macos")]
            if test_root.is_none() && !preferences.as_ref().is_some_and(|p| p.legacy_login_checked)
            {
                match reconcile_legacy_login() {
                    Ok(enabled) => {
                        if enabled {
                            if let Err(error) = app.autolaunch().enable() {
                                report(app.handle(), format!("旧登录项已移除，新开机启动未能启用：{error}。请从桌面设置重试。"));
                            }
                        }
                        save_preferences(app.handle())?;
                    }
                    Err(error) => {
                        app.state::<Desktop>()
                            .legacy_login_blocked
                            .store(true, Ordering::SeqCst);
                        report(app.handle(), error);
                    }
                }
            }
            if !background || !app.state::<Desktop>().has_tray.load(Ordering::SeqCst) {
                let _ = show_window(app.handle());
            }
            let handle = app.handle().clone();
            thread::spawn(move || {
                if !first_run {
                    let _ = save_preferences(&handle);
                    let _ = handle
                        .state::<Desktop>()
                        .backend
                        .lock()
                        .unwrap()
                        .start(true);
                    publish(&handle);
                }
                let mut last_check = Instant::now() - Duration::from_secs(86400);
                loop {
                    thread::sleep(Duration::from_secs(1));
                    let state = handle.state::<Desktop>();
                    if state.quitting.load(Ordering::SeqCst) {
                        continue;
                    }
                    if state.updates.lock().unwrap().view.status == "installing" {
                        continue;
                    }
                    let changed = state.backend.lock().unwrap().poll();
                    if changed {
                        publish(&handle);
                        let status = state.backend.lock().unwrap().status.clone();
                        if status == "error" && !state.background.load(Ordering::SeqCst) {
                            let _ = show_window(&handle);
                        }
                    }
                    if !state.testing && last_check.elapsed() >= Duration::from_secs(86400) {
                        last_check = Instant::now();
                        let app = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = check_for_updates(app, true).await;
                        });
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<Desktop>();
                if !state.exit_ready.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if state.has_tray.load(Ordering::SeqCst) {
                        let _ = window.hide();
                    } else {
                        let _ = window.minimize();
                    }
                }
            }
        });
    builder
        .build(tauri::generate_context!())
        .expect("Unable to start Elysia API desktop")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. }
                if !app.state::<Desktop>().exit_ready.load(Ordering::SeqCst) =>
            {
                api.prevent_exit();
                request_quit(app.clone());
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                let _ = show_panel(app.clone());
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_only_allows_packaged_origins() {
        for address in [
            "tauri://localhost/ui/index.html#/runtime",
            "http://tauri.localhost/ui/index.html",
            "https://tauri.localhost/ui/index.html",
        ] {
            assert!(app_navigation(&tauri::Url::parse(address).unwrap()));
        }
        for address in [
            "blob:tauri://localhost/untrusted-export",
            "http://tauri.localhost:8765/",
            "http://user@tauri.localhost/",
            "tauri://other/ui/index.html",
            "https://example.com/",
            "file://tauri.localhost/tmp/export.html",
        ] {
            assert!(!app_navigation(&tauri::Url::parse(address).unwrap()));
        }
    }

    #[test]
    fn cancellation_or_quit_prevents_install_after_verification() {
        for status in ["downloading", "verifying"] {
            let mut updates = Updates {
                view: UpdateView {
                    status: status.into(),
                    ..UpdateView::default()
                },
                cancel: Some(Arc::new(tokio::sync::Notify::new())),
                cancel_requested: true,
                ..Updates::default()
            };
            assert!(!updates.begin_install(false));
            assert_eq!(updates.view.status, "available");
            assert!(updates.cancel.is_none());
            assert!(updates.cancel_requested);
        }

        let mut updates = Updates::default();
        updates.view.status = "verifying".into();
        assert!(!updates.begin_install(true));
        assert_eq!(updates.view.status, "available");

        updates.cancel = Some(Arc::new(tokio::sync::Notify::new()));
        assert!(updates.begin_install(false));
        assert_eq!(updates.view.status, "installing");
        assert!(updates.cancel.is_none());
    }
}
