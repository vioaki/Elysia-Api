use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn default_host() -> String {
    "127.0.0.1".into()
}
fn default_port() -> u16 {
    8765
}

#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PanelConfig {
    pub host: String,
    pub port: u16,
    pub panel_access_token: String,
}

impl Default for PanelConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            port: default_port(),
            panel_access_token: String::new(),
        }
    }
}

impl PanelConfig {
    pub fn read(dir: &Path) -> Result<Self, String> {
        let path = dir.join("config.json");
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e.to_string()),
        };
        #[derive(Default, Deserialize)]
        #[serde(default, rename_all = "camelCase")]
        struct ConfigFile {
            host: Option<String>,
            port: Option<u16>,
            panel_access_token: Option<String>,
            server: Option<PanelConfig>,
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("配置无法读取，原文件已保留：{}\n{e}", path.display()))?;
        if !value.is_object() {
            return Err("配置必须是 JSON 对象，原文件已保留。".into());
        }
        let raw: ConfigFile = serde_json::from_value(value)
            .map_err(|e| format!("配置无法读取，原文件已保留：{}\n{e}", path.display()))?;
        let legacy = raw.server.unwrap_or_default();
        // Match Go's bootstrap defaults: top-level values win, then legacy server.
        let config = Self {
            host: raw.host.filter(|v| !v.is_empty()).unwrap_or_else(|| {
                if legacy.host.is_empty() {
                    default_host()
                } else {
                    legacy.host
                }
            }),
            port: raw
                .port
                .filter(|v| *v != 0)
                .or_else(|| (legacy.port != 0).then_some(legacy.port))
                .unwrap_or_else(default_port),
            panel_access_token: raw.panel_access_token.unwrap_or_default(),
        };
        if config.port == 0 || config.host.trim().is_empty() {
            return Err("配置 host/port 无效，请修正 config.json。".into());
        }
        Ok(config)
    }

    pub fn api_address(&self) -> String {
        let host = match self.host.as_str() {
            "0.0.0.0" => "127.0.0.1",
            "::" | "[::]" => "::1",
            host => host,
        };
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        format!("http://{host}:{}", self.port)
    }
}

pub fn default_data_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base =
        std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Library/Application Support"));
    #[cfg(target_os = "linux")]
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/share")));
    base.map(|p| p.join("ElysiaApi"))
        .ok_or_else(|| "无法确定用户数据目录。".into())
}

pub fn write_port(dir: &Path, port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("端口必须为 1–65535。".into());
    }
    let path = dir.join("config.json");
    if !path.try_exists().map_err(|e| e.to_string())? {
        // Reuse Go's secure defaults, including its random panel token.
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let output = sidecar_command()?
            .arg("--config")
            .arg(&path)
            .arg("--init-config")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "创建配置失败：{}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }
    let mut config: Value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let object = config
        .as_object_mut()
        .ok_or("配置必须是 JSON 对象，原文件已保留。")?;
    object.insert("port".into(), json!(port));
    let temporary = dir.join(format!(".config-port-{}.tmp", std::process::id()));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        fs::set_permissions(
            &temporary,
            fs::metadata(&path)
                .map_err(|e| e.to_string())?
                .permissions(),
        )
        .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, &path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn sidecar_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = if cfg!(windows) {
        "elysia-api.exe"
    } else {
        "elysia-api"
    };
    let adjacent = exe.parent().ok_or("无法确定后端路径。")?.join(name);
    if adjacent.is_file() {
        return Ok(adjacent);
    }
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "elysia-api-{}{}",
                env!("ELYSIA_TARGET_TRIPLE"),
                if cfg!(windows) { ".exe" } else { "" }
            ));
        if source.is_file() {
            return Ok(source);
        }
    }
    Err(format!("安装包缺少后端：{}", adjacent.display()))
}

fn sidecar_command() -> Result<Command, String> {
    #[allow(unused_mut)] // Windows adds CREATE_NO_WINDOW below.
    let mut command = Command::new(sidecar_path()?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command)
}

pub struct Backend {
    pub data_dir: PathBuf,
    pub config: PanelConfig,
    pub status: String,
    pub message: String,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    retries: u8,
    retry_at: Option<Instant>,
    started: Option<Instant>,
    stop_requested: bool,
    client: reqwest::blocking::Client,
}

impl Backend {
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        Ok(Self {
            config: PanelConfig::default(),
            data_dir,
            status: "stopped".into(),
            message: "服务尚未启动。".into(),
            child: None,
            stdin: None,
            retries: 0,
            retry_at: None,
            started: None,
            stop_requested: false,
            client: reqwest::blocking::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .map_err(|e| e.to_string())?,
        })
    }

    pub fn has_child(&self) -> bool {
        self.child.is_some()
    }
    pub fn log_path(&self) -> PathBuf {
        self.data_dir.join("elysia-api.log")
    }

    pub fn log(&self, text: &str) {
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_path())
        {
            let _ = writeln!(file, "[desktop] {text}");
        }
    }

    pub fn start(&mut self, manual: bool) -> Result<(), String> {
        if self.child.is_some() {
            return Err("后端仍在运行或退出中，请稍后重试。".into());
        }
        if manual {
            self.retries = 0;
        }
        self.retry_at = None;
        self.stop_requested = false;
        let result = self.spawn();
        if let Err(error) = &result {
            self.status = "error".into();
            self.message = error.clone();
            self.log(error);
        }
        result
    }

    fn spawn(&mut self) -> Result<(), String> {
        fs::create_dir_all(&self.data_dir).map_err(|e| e.to_string())?;
        self.config = PanelConfig::read(&self.data_dir)?;
        let host = std::env::var("ELYSIA_API_HOST")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| self.config.host.clone());
        self.config.host = host.trim().to_string();
        // Preflight preserves the configured API address; never attach to another listener.
        TcpListener::bind((self.config.host.trim_matches(['[', ']']), self.config.port)).map_err(
            |e| {
                format!(
                    "端口 {} 无法监听（{e}）。请释放端口，或在服务停止后修改端口。",
                    self.config.port
                )
            },
        )?;
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_path())
            .map_err(|e| e.to_string())?;
        let mut command = sidecar_command()?;
        command
            .args(["--config"])
            .arg(self.data_dir.join("config.json"))
            .current_dir(&self.data_dir)
            .env("ELYSIA_API_OPEN_BROWSER", "false")
            .env("ELYSIA_API_SHUTDOWN_ON_STDIN_EOF", "1")
            .env("ELYSIA_API_DESKTOP_ORIGIN", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        self.stdin = child.stdin.take();
        self.log(&format!(
            "Started owned backend PID {} on {}",
            child.id(),
            self.config.api_address()
        ));
        self.child = Some(child);
        self.started = Some(Instant::now());
        self.status = "starting".into();
        self.message = "正在启动后端并检查数据库…".into();
        Ok(())
    }

    pub fn stop(&mut self, allow_kill: bool) -> Result<(), String> {
        self.retry_at = None;
        self.stop_requested = true;
        let Some(child) = self.child.as_mut() else {
            self.status = "stopped".into();
            self.message = "服务已停止。".into();
            return Ok(());
        };
        self.status = "stopping".into();
        self.message = "正在停止服务并保存用量记录…".into();
        // Closing only our child's pipe works on every OS and shares Go's graceful shutdown.
        self.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                break;
            }
            if Instant::now() >= deadline {
                if !allow_kill {
                    self.status = "error".into();
                    self.message = "后端未在 12 秒内退出，已中止更新。请查看日志。".into();
                    return Err(self.message.clone());
                }
                child.kill().map_err(|e| e.to_string())?;
                child.wait().map_err(|e| e.to_string())?;
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        self.child = None;
        self.started = None;
        self.status = "stopped".into();
        self.message = "服务已停止。".into();
        self.log("Owned backend stopped");
        Ok(())
    }

    pub fn poll(&mut self) -> bool {
        let before = (self.status.clone(), self.message.clone());
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(exit)) => {
                    self.child = None;
                    self.stdin = None;
                    self.retry_at = None;
                    self.started = None;
                    if self.stop_requested {
                        self.status = "stopped".into();
                        self.message = "服务已停止。".into();
                    } else if self.retries < 3 {
                        self.retries += 1;
                        self.retry_at =
                            Some(Instant::now() + Duration::from_secs(1 << (self.retries - 1)));
                        self.status = "starting".into();
                        self.message =
                            format!("后端意外退出（{exit}），正在恢复（{}/3）。", self.retries);
                    } else {
                        self.status = "error".into();
                        self.message =
                            format!("后端意外退出（{exit}），自动恢复已停止。请查看日志后重试。");
                    }
                    self.log(&self.message);
                }
                Err(e) => {
                    self.status = "error".into();
                    self.message = e.to_string();
                }
                Ok(None) if self.stop_requested => {}
                Ok(None) => {
                    // Runtime settings can rotate the token without restarting the listener.
                    if let Ok(config) = PanelConfig::read(&self.data_dir) {
                        self.config.panel_access_token = config.panel_access_token;
                    }
                    let response = self
                        .client
                        .get(format!("{}/api/admin/health", self.config.api_address()))
                        .bearer_auth(&self.config.panel_access_token)
                        .send();
                    let unauthorized = response
                        .as_ref()
                        .is_ok_and(|r| r.status() == reqwest::StatusCode::UNAUTHORIZED);
                    // The bind preflight is racy; verify this listener belongs to our child.
                    let healthy = response
                        .ok()
                        .filter(|r| r.status().is_success())
                        .and_then(|r| r.json::<Value>().ok())
                        .is_some_and(|value| {
                            value["data"]["processID"].as_u64() == Some(u64::from(child.id()))
                                && value["data"]["database"] == true
                        });
                    if healthy {
                        self.status = "running".into();
                        self.message = "服务运行中；关闭窗口后仍继续运行。".into();
                    } else if self
                        .started
                        .is_some_and(|t| t.elapsed() > Duration::from_secs(30))
                    {
                        if unauthorized {
                            self.message =
                                "面板令牌校验失败，请检查 config.json 的 panelAccessToken。".into();
                        } else {
                            self.message = "后端健康检查未通过，请查看运行日志。".into();
                        }
                        self.status = "error".into();
                    }
                }
            }
        } else if self.retry_at.is_some_and(|t| Instant::now() >= t) {
            let _ = self.start(false);
        }
        before != (self.status.clone(), self.message.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("elysia-desktop-{name}-{}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn attach_child(backend: &mut Backend, mode: &str) {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "backend::tests::child_fixture", "--nocapture"])
            .env("ELYSIA_DESKTOP_TEST_CHILD", mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        backend.stdin = child.stdin.take();
        backend.child = Some(child);
        backend.started = Some(Instant::now());
        backend.status = "starting".into();
    }

    #[test]
    fn child_fixture() {
        match std::env::var("ELYSIA_DESKTOP_TEST_CHILD").as_deref() {
            Ok("wait") => {
                let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
            }
            Ok("crash") => std::process::exit(23),
            Ok("slow") => thread::sleep(Duration::from_secs(30)),
            _ => return,
        }
        std::process::exit(0);
    }

    #[test]
    fn config_port_and_address_preserve_data() {
        let dir = TestDir::new("config");
        let path = dir.0.join("config.json");
        fs::write(&path, r#"{"host":"::","port":8765,"databasePath":"../old/data.sqlite3","custom":{"keep":true},"panelAccessToken":"secret"}"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        }
        write_port(&dir.0, 9010).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["databasePath"], "../old/data.sqlite3");
        assert_eq!(value["custom"]["keep"], true);
        assert_eq!(value["panelAccessToken"], "secret");
        assert_eq!(
            PanelConfig::read(&dir.0).unwrap().api_address(),
            "http://[::1]:9010"
        );
        assert!(write_port(&dir.0, 0).is_err());
        fs::write(&path, r#"{"server":{"host":"127.0.0.2","port":9123}}"#).unwrap();
        assert_eq!(
            PanelConfig::read(&dir.0).unwrap().api_address(),
            "http://127.0.0.2:9123"
        );
        fs::write(
            &path,
            r#"{"host":"127.0.0.1","port":9010,"server":{"host":"127.0.0.2","port":9123}}"#,
        )
        .unwrap();
        assert_eq!(
            PanelConfig::read(&dir.0).unwrap().api_address(),
            "http://127.0.0.1:9010"
        );
        fs::write(&path, "broken").unwrap();
        assert!(PanelConfig::read(&dir.0).is_err());
        assert!(write_port(&dir.0, 9000).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "broken");
        fs::write(&path, "[]").unwrap();
        assert!(PanelConfig::read(&dir.0).is_err());
        assert!(write_port(&dir.0, 9000).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "[]");
    }

    #[test]
    fn occupied_port_never_attaches_or_changes_address() {
        let dir = TestDir::new("occupied");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        fs::write(
            dir.0.join("config.json"),
            format!(r#"{{"host":"127.0.0.1","port":{port}}}"#),
        )
        .unwrap();
        let mut backend = Backend::new(dir.0.clone()).unwrap();
        assert!(backend.start(true).is_err());
        assert!(!backend.has_child());
        assert_eq!(backend.config.port, port);
        assert_eq!(backend.status, "error");
        assert!(TcpListener::bind(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn changing_port_bootstraps_secure_config_without_starting_server() {
        let dir = TestDir::new("bootstrap");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        write_port(&dir.0, port).unwrap();
        let config = PanelConfig::read(&dir.0).unwrap();
        assert_eq!(config.port, port);
        assert!(config.panel_access_token.starts_with("elysia-"));
        assert!(config.panel_access_token.len() > 40);
        assert!(!dir.0.join("elysia-api.sqlite3").exists());
        assert!(!dir.0.join(".master-key").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.0.join("config.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert!(TcpListener::bind(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn graceful_stop_closes_own_stdin_and_disables_recovery() {
        let dir = TestDir::new("stop");
        let mut backend = Backend::new(dir.0.clone()).unwrap();
        attach_child(&mut backend, "wait");
        backend.stop(false).unwrap();
        assert!(!backend.has_child());
        assert!(backend.stdin.is_none());
        assert!(backend.retry_at.is_none());
        assert!(!backend.poll());
        assert_eq!(backend.status, "stopped");
    }

    #[test]
    fn real_sidecar_becomes_ready_and_stops_via_stdin() {
        let dir = TestDir::new("real-sidecar");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        write_port(&dir.0, port).unwrap();
        let mut backend = Backend::new(dir.0.clone()).unwrap();
        backend.start(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline && backend.status == "starting" {
            backend.poll();
            thread::sleep(Duration::from_millis(20));
        }
        let ready = backend.status == "running";
        let message = backend.message.clone();
        let stopped = backend.stop(false);
        assert!(ready, "sidecar was not ready: {message}");
        stopped.unwrap();
        assert!(!backend.has_child());
        assert!(dir.0.join("elysia-api.sqlite3").is_file());
        assert!(dir.0.join(".master-key").is_file());
    }

    #[test]
    fn updates_abort_without_killing_and_delayed_stop_stays_stopped() {
        let dir = TestDir::new("slow-stop");
        let mut backend = Backend::new(dir.0.clone()).unwrap();
        attach_child(&mut backend, "slow");
        let result = backend.stop(false);
        let alive = backend
            .child
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none();
        // This test kills its fake stalled child only after recording the update result.
        backend.child.as_mut().unwrap().kill().unwrap();
        backend.child.as_mut().unwrap().wait().unwrap();
        assert!(result.is_err());
        assert!(alive);
        assert!(backend.poll());
        assert_eq!(backend.status, "stopped");
        assert!(backend.retry_at.is_none());
    }

    #[test]
    fn crashes_schedule_at_most_three_recoveries() {
        let dir = TestDir::new("crash");
        let mut backend = Backend::new(dir.0.clone()).unwrap();
        for attempt in 1..=4 {
            attach_child(&mut backend, "crash");
            backend.child.as_mut().unwrap().wait().unwrap();
            backend.poll();
            assert!(!backend.has_child());
            assert_eq!(backend.retries, attempt.min(3));
            assert_eq!(backend.retry_at.is_some(), attempt <= 3);
        }
        assert_eq!(backend.status, "error");
    }

    #[test]
    fn health_requires_our_child_process_and_database() {
        let dir = TestDir::new("health");
        let config = dir.0.join("config.json");
        fs::write(&config, r#"{"panelAccessToken":"initial"}"#).unwrap();
        let mut backend = Backend::new(dir.0.clone()).unwrap();
        backend.config = PanelConfig::read(&dir.0).unwrap();
        attach_child(&mut backend, "wait");
        let pid = backend.child.as_ref().unwrap().id();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        backend.config.port = listener.local_addr().unwrap().port();
        let responses = thread::spawn(move || {
            for (process, database, token) in [
                (pid + 1, true, "initial"),
                (pid, false, "rotated"),
                (pid, true, "rotated"),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 4096];
                let length = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..length])
                    .contains(&format!("Bearer {token}")));
                let body =
                    json!({"data": {"processID": process, "database": database}}).to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        backend.poll();
        assert_eq!(backend.status, "starting");
        fs::write(&config, r#"{"panelAccessToken":"rotated"}"#).unwrap();
        backend.poll();
        assert_eq!(backend.status, "starting");
        backend.poll();
        let status = backend.status.clone();
        backend.stop(false).unwrap();
        responses.join().unwrap();
        assert_eq!(status, "running");
    }
}
