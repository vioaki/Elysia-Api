use std::{
    fs,
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

// Keep the official installer, but protect the current bundle against its
// missing rollback after moving the old app into a temporary directory.
pub fn install_with_backup(
    current: &Path,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if current.extension().is_none_or(|ext| ext != "app")
        || !fs::symlink_metadata(current)
            .map_err(|e| e.to_string())?
            .is_dir()
    {
        return Err("请从已安装的 .app 应用包中更新。".into());
    }
    let parent = current.parent().ok_or("无法确定应用目录。")?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let suffix = format!("{}-{nonce}", std::process::id());
    let backup = parent.join(format!(".ElysiaApi-update-backup-{suffix}"));
    let failed = parent.join(format!(".ElysiaApi-failed-update-{suffix}"));

    // Creating the backup beside the app proves this directory is writable
    // before the plugin can remove anything; ditto preserves bundle metadata.
    fs::create_dir(&backup).map_err(|e| format!("应用目录无法写入，更新未安装：{e}"))?;
    let copy = Command::new("/usr/bin/ditto")
        .arg(current)
        .arg(&backup)
        .output();
    match copy {
        Ok(output) if output.status.success() => {}
        result => {
            let _ = fs::remove_dir_all(&backup);
            return Err(match result {
                Ok(output) => format!(
                    "无法备份当前应用，更新未安装：{}",
                    String::from_utf8_lossy(&output.stderr)
                ),
                Err(error) => format!("无法备份当前应用，更新未安装：{error}"),
            });
        }
    }

    match install() {
        Ok(()) => {
            if let Err(error) = fs::remove_dir_all(&backup) {
                // Installation already succeeded. Retain a recoverable copy
                // rather than report an installation failure after the fact.
                eprintln!(
                    "更新已安装，但恢复备份未能清理：{} ({error})",
                    backup.display()
                );
            }
            Ok(())
        }
        Err(install_error) => {
            let restored = (|| -> std::io::Result<()> {
                match fs::symlink_metadata(current) {
                    Ok(_) => fs::rename(current, &failed)?,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                fs::rename(&backup, current)
            })();
            if let Err(error) = restored {
                return Err(format!(
                    "{install_error}\n旧版本自动恢复失败（{error}），完整恢复备份保留在：{}",
                    backup.display()
                ));
            }
            if fs::symlink_metadata(&failed).is_ok_and(|metadata| metadata.is_dir()) {
                let _ = fs::remove_dir_all(&failed);
            } else {
                let _ = fs::remove_file(&failed);
            }
            Err(format!("{install_error}\n已恢复原应用，当前版本未更改。"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn fixture(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root =
            std::env::temp_dir().join(format!("elysia-update-{name}-{}", std::process::id()));
        let app = root.join("ElysiaApi.app");
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        fs::write(app.join("Contents/MacOS/ElysiaApi"), b"original executable").unwrap();
        fs::set_permissions(
            app.join("Contents/MacOS/ElysiaApi"),
            fs::Permissions::from_mode(0o751),
        )
        .unwrap();
        symlink("MacOS/ElysiaApi", app.join("Contents/executable-link")).unwrap();
        fs::create_dir(root.join("data")).unwrap();
        fs::write(root.join("data/config.json"), b"separate user data").unwrap();
        (root, app)
    }

    #[test]
    fn restores_original_when_installer_deletes_or_damages_bundle() {
        for damage in ["deleted", "damaged", "file"] {
            let (root, app) = fixture(damage);
            let result = install_with_backup(&app, || {
                if damage == "deleted" {
                    fs::remove_dir_all(&app).unwrap();
                } else if damage == "file" {
                    fs::remove_dir_all(&app).unwrap();
                    fs::write(&app, b"partial update in place of app directory").unwrap();
                } else {
                    fs::write(app.join("Contents/MacOS/ElysiaApi"), b"partial update").unwrap();
                    fs::write(app.join("Contents/new-file"), b"partial update").unwrap();
                }
                Err("official installer failed".into())
            });
            assert!(result.unwrap_err().contains("已恢复原应用"));
            assert_eq!(
                fs::read(app.join("Contents/MacOS/ElysiaApi")).unwrap(),
                b"original executable"
            );
            assert_eq!(
                fs::metadata(app.join("Contents/MacOS/ElysiaApi"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o751
            );
            assert_eq!(
                fs::read_link(app.join("Contents/executable-link")).unwrap(),
                Path::new("MacOS/ElysiaApi")
            );
            assert!(!app.join("Contents/new-file").exists());
            assert_eq!(
                fs::read(root.join("data/config.json")).unwrap(),
                b"separate user data"
            );
            assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn successful_official_install_removes_protection_backup() {
        let (root, app) = fixture("success");
        install_with_backup(&app, || {
            fs::write(app.join("Contents/MacOS/ElysiaApi"), b"updated executable").unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(
            fs::read(app.join("Contents/MacOS/ElysiaApi")).unwrap(),
            b"updated executable"
        );
        assert_eq!(
            fs::read(root.join("data/config.json")).unwrap(),
            b"separate user data"
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_dir_all(root).unwrap();
    }
}
