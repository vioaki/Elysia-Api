# Unified desktop builds and acceptance

[Documentation](README.en.md) · [简体中文](desktop-testing.md) · **English**

The unified desktop uses Tauri 2 for one window, the tray and the Go child process. The window loads the existing React WebUI bundled with the app. Service, port, data directory, startup and updater controls live in its runtime settings page; the login page exposes the same controls through a shared settings dialog. Go still embeds WebUI for ordinary browser access. Existing server binaries, Docker and the production Swift macOS release remain available. Explicitly promote desktop packages only after migration acceptance.

The local React UI remains available when Go is stopped or fails to start, including settings, status and recovery actions. Packaged pages receive only the listed desktop-command permissions; Rust manages the bundled backend. Browser WebUI served by Go receives no desktop permissions. The app starts its own bundled sidecar only, with no external binary or arbitrary WebUI-origin chooser. Existing data directories can still be selected and reused.

## Local builds

Install Node.js 22+, Go 1.25+, Rust stable and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Windows needs MSVC and WebView2. macOS needs Xcode Command Line Tools and targets macOS 12+. Linux packages use an Ubuntu 22.04 baseline:

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev patchelf
```

After installing Rust, open a new terminal and verify `cargo --version` and `rustc --version`. In the current Unix terminal, run `source "$HOME/.cargo/env"`; on Windows, refresh the terminal PATH.

From the repository root:

```sh
npm install
npm run test:desktop:release
npm run build:desktop -- --version 1.2.0-desktop.1
```

The default builds the host architecture only. `prepareWebui({ desktop: true })` validates and builds the existing React WebUI, copying the same output into both the Go embed directory and `packages/desktop/frontend/ui/`. The script then builds the required Go sidecar and Tauri. One version is injected through Go ldflags and a temporary Tauri configuration; tracked version files are untouched. Prepare only the development sidecar with:

```sh
npm run build:desktop:backend
npm run dev --workspace @root/desktop
```

Tauri `dev` first builds the local React pages, then loads local assets; it does not start another UI development server. Restart that command after UI changes to refresh the packaged pages. The separate desktop control page and its dedicated UI tests have been removed; desktop controls and recovery use the existing React components and test entry points.

The build script passes both `--ci` and `CI=true` to Tauri's native noninteractive bundling path. The macOS DMG retains the app and Applications link while skipping Finder/AppleScript background and icon positioning. The same path works with a locked or displayless desktop. Set both values when invoking Tauri bundling directly.

Go adds `--init-config`: combine it with `--config <path>` to create missing configuration or validate an existing file, then exit without starting HTTP. The desktop reuses Go's random panel token and defaults this way. Damaged configuration returns an error and preserves the original file.

Readiness uses authenticated `GET /api/admin/health` with the panel token. It requires `data.processID` to match the newly spawned child's PID and `data.database=true`. Health checks immediately read a panel token rotated in WebUI while retaining the active listener address, avoiding a false failure caused by a cached token. Process identity prevents a listener that won a port-binding race from being treated as the owned backend. Public `/health` remains the ordinary health and version endpoint.

Build the universal package on macOS:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build:desktop -- --target universal-apple-darwin --version 1.2.0-desktop.1
```

Windows targets are `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`; Linux targets are `x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu`. Build on the matching operating system and architecture. Ordinary local builds disable updater artifact signing. `--updater` requires `TAURI_SIGNING_PRIVATE_KEY`; encrypted keys also require `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. `--update-url` overrides the HTTPS manifest endpoint.

Outputs go to `dist/desktop/<target>/`:

| Platform | Installer | Signed updater artifact |
| --- | --- | --- |
| Universal macOS | `elysia-api-macos.dmg` | `elysia-api-macos.app.tar.gz` and `.sig` |
| Windows x64 / ARM64 | `elysia-api-desktop-windows-{amd64,arm64}-setup.exe` | Same installer and `.sig` |
| Linux x64 / ARM64 | `elysia-api-desktop-linux-{amd64,arm64}.AppImage` | Same AppImage and `.sig` |

macOS preserves `ElysiaApi.app`, identifier `dev.pinkelysiadev.ElysiaApi`, and executables `Contents/MacOS/ElysiaApi` and `elysia-api`. Builds verify the Info.plist bundle identifier and main executable name; universal builds also verify both architectures, ad-hoc signatures and DMG integrity. Single-architecture development packages cannot migrate through the old Swift updater.

## Preview releases and stable promotion

The **Build and preview unified desktop** workflow runs manually and defaults to `publish=false`, `promote_stable=false`. Configure repository secrets first:

- `TAURI_SIGNING_PRIVATE_KEY`: updater private key contents matching the public key in `tauri.conf.json`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: private key password, empty for an unencrypted key.

Keep the private key outside the repository and in CI Secrets; never commit or print it. Losing the matching private key prevents updates to existing clients with a replacement public key; use an old-key-signed transition release or manual reinstall. Updater keys are free and separate from commercial code-signing certificates. macOS uses ad-hoc signing and Windows has no commercial signature; first-install OS prompts remain.

The workflow builds on native macOS, Windows x64/ARM64, Ubuntu 22.04 x64 and an Ubuntu 22.04 ARM64 QEMU container. Five packages cover six platforms; both macOS updater entries share the universal archive. Complete packages and signatures are required before generating `latest.json` and `SHA256SUMS`.

1. Use a prerelease version such as `1.2.0-desktop.1` with `publish=false`, then download workflow artifacts for acceptance.
2. Set `publish=true` to distribute a preview. The workflow creates `desktop-v<version>` as a prerelease and updates the manifest on the `desktop-preview` prerelease. Preview clients read `https://github.com/PinkElysiaDev/Elysia-Api/releases/download/desktop-preview/latest.json`; package URLs point to the fixed version release.
3. After hardware and upgrade acceptance, create the stable `v<version>` release through the existing pipeline. Check out that tag, run the desktop workflow with the stable version and set both `publish=true` and `promote_stable=true`.
4. Promotion requires the existing latest release to be stable and match the source commit. It adds desktop packages and `latest.json`, explicitly replaces the Swift DMG, and merges existing server checksums. Server binaries and Docker stay on their current release path. Stable clients read `https://github.com/PinkElysiaDev/Elysia-Api/releases/latest/download/latest.json`.

Retain the Swift production shell and stable endpoint until acceptance is complete. To roll back a preview, point `desktop-preview/latest.json` to an accepted release, then reinstall manually; the updater does not downgrade automatically. Stable rollback also requires a signed package and compatible data.

Before a macOS update, copy the complete `.app` beside the installed app; reject installation if that directory is unwritable. Restore the original app when the official installer fails. If restoration also fails, retain the complete backup and show its path for manual recovery.

## Automated checks and hardware acceptance

```sh
npm run test:desktop:release
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
cd backend && go test ./...
```

Reuse the same test entry point to verify a signed artifact cryptographically:

```sh
DESKTOP_UPDATER_ARTIFACT=dist/desktop/universal-apple-darwin/elysia-api-macos.app.tar.gz DESKTOP_UPDATER_VERSION=1.0.0-desktop.1 npm run test:desktop:release
```

This reads only the archive, `.sig` and repository public key to check the content signature, protected version comment and key identity; no private key is needed. The release-manifest command runs this check for each update artifact and rejects signatures that do not match the app's bundled public key.

For a local UI smoke check, launch a debug build with a fresh temporary directory:

```sh
desktop_test_dir="$(mktemp -d)"
ELYSIA_DESKTOP_TEST_ROOT="$desktop_test_dir" npm run dev --workspace @root/desktop
```

`ELYSIA_DESKTOP_TEST_ROOT` **only applies to debug builds**. It stores `desktop.json` there, defaults initial data to `data/` inside it, skips old startup-registration migration and automatic update checks, and rejects changes to system startup items. Use a fresh directory: existing preferences can still point to a manually chosen data directory. Release packages ignore this variable; it does not isolate a production installation. WebView login storage, system registration and actual upgrades need separate acceptance. Remove the temporary directory after explicitly quitting the app.

After building the universal macOS package, `node scripts/test-desktop-macos-migration.mjs --dmg <local-DMG-path>` exercises the actual old Swift installer in a disposable directory. It verifies the package, extraction and whole-app replacement, checking byte-identical data sentinels. This tests old-installer/new-package compatibility only; it does not prove network upgrades, target UI or login-item migration.

Release-script checks cover SemVer, host/target mapping, six-platform manifests, universal archive sharing, missing package/bad signature rejection, server checksum preservation, unsafe filenames and incompatible macOS identities. They validate complete Minisign formatting and the signed version field against the manifest. Clients enable `requireSignedVersion`; Tauri signer/updater performs cryptographic verification. Rust/Go checks and successful builds do not replace these acceptance checks.

| Area | Action and pass condition |
| --- | --- |
| Six platforms | Install and double-click on macOS Intel/Apple Silicon, Windows x64/ARM64 and Linux x64/ARM64. Verify usable windows without terminal popups; test Linux with and without a tray. |
| Single instance/background | Reopening restores one window. Closing keeps the service running; without a tray, minimizing remains recoverable. Explicit quit leaves no owned Go process. |
| Fixed port | Occupy 8765 or the configured port. The app shows conflict and supports retry/config change, without adopting another process. Existing configuration wins. |
| Lifecycle | Manual stop never restarts. Crashes recover at most three times. Killing the shell closes stdin and stops the owned Go process. Normal shutdown drains database/log/stream work. |
| Data reuse | Reuse the macOS directory; choose an old directory on Windows/Linux. Preserve config, SQLite, master key, attachments, model sources and custom paths. Preserve damaged config. Use backed-up test data and avoid concurrent database access. |
| Startup registration | Migrating from Swift results in one startup instance. Failed old-item removal shows system-settings guidance and does not add a duplicate. Disabling prevents the next-login launch. |
| Panel | Empty initial login form, copied token and manual sign-in; window reopening, logout, streams, exports/downloads, copy/paste and external links work. |
| Token rotation | Change the panel token in WebUI runtime settings. Health checks use the new token, without reporting failure or restarting Go due to a cached token; the active listener address stays unchanged. |
| Unified settings/recovery | One window presents the React console. Runtime settings and the shared settings dialog on login expose consistent desktop controls. After stopping Go, local React remains available for port changes, old-data-directory selection, restart and update checks. |
| Permissions | Packaged React pages can invoke only authorized desktop commands. Opening Go `/ui/` in an ordinary browser exposes no desktop controls or native-command privileges; external links open in the system browser. |
| Failed updates | Offline/no update/cancellation/bad signature/unwritable directory/shutdown failure preserve usable current version and data. Bad signature never stops the service. |
| Successful updates | Download and verify first; install only after the owned service exits. Windows installer exit also waits for shutdown. After restart, Go `/health`, Tauri and WebUI belong to the same release. |
| Two actual upgrades | Upgrade old Swift to universal Tauri, then one Tauri version to the next. Preserve login state, config, SQLite, keys and attachments. Record OS/architecture, source version, target version and outcome. |

Record incomplete hardware checks as “not yet verified” and retain prerelease status.

## Local acceptance record

After rotating a running panel token, 35 seconds of observation confirmed the same healthy Go process and a running desktop status; the previous frontend session signed out on 401 as expected.

2026-10-01, macOS Apple Silicon, isolated debug bundle ID `.NativeTest`: verified native login in the single React window, menus, runtime settings, sidebar retention after stopping Go, fixed-port changes and restart, pprof Blob downloads, duplicate launch, closing/reopening, explicit quit without leftover processes, and child exit on stdin EOF after SIGKILL of the parent.

Signed loopback update fixtures verified that bad signatures, cancellation and offline failures preserve the same Go process. Installation of a test archive containing AppleDouble files failed; the protection backup restored the original `.app` and restarted Go. Removing AppleDouble allowed `.1→.2` to succeed: React, native and Go health versions matched, login persisted, configuration/key/attachment hashes were unchanged, and the database remained healthy. This was an isolated local upgrade test, not a production network Release upgrade.

The final universal package passed verification, extraction, replacement and byte-sentinel compatibility with the old Swift installer. Full old-Swift network/UI/startup migration, macOS Intel hardware, Windows/Linux hardware on both architectures, and startup registration remain unverified. Maintainers still need to configure CI Secrets; nothing was published.
