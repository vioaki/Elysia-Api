# macOS native testing

[Documentation](README.en.md) · [简体中文](macos-testing.md) · **English**

Use this guide to verify the native shell, updater and embedded panel. Run commands from the repository root after installing dependencies with the [development guide](development.en.md).

## Prerequisites

The App targets macOS 12+. The build host needs compatible Command Line Tools (or full Xcode), Node.js and Go 1.25+. Its toolchain must link macOS 12 Swift programs for both arm64 and x86_64. The shell uses system frameworks; tests use Swift, AppKit, WebKit, the Python standard library and Clang-built architecture fixtures. Running and updating the packaged App requires no developer tools.

## Toolchain and universal builds

Apple documentation checked on 2026-09-14:

- [Installing Command Line Tools](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools): CLT can replace full Xcode and includes the macOS SDK/toolchain. Only one CLT version is installed at a time; updates replace it.
- [Xcode support table](https://developer.apple.com/support/xcode/): choose a toolchain compatible with the build host. At that check, Xcode 26.6 supported macOS Tahoe 26.2–26.x hosts and macOS 11–26.5 deployment targets.
- [Xcode 27 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes#Intel-Deprecation): Xcode itself runs only on Apple Silicon, while the macOS 27 SDK still supports Intel + Apple Silicon universal apps targeting macOS 12+. Missing local Intel libraries do not establish that universal support was removed.

Run the standalone check before building backend binaries:

```sh
xcode-select -p
pkgutil --pkg-info com.apple.pkg.CLTools_Executables
xcrun --sdk macosx swiftc --version
npm run build:macos-app -- --check-toolchain
```

The build script selects Swift through `xcrun --sdk macosx` and actually links a minimal AppKit program for both architectures. Failure stops before removing an existing App or DMG. Normal builds perform the same preflight.

In the recorded local CLT `27.0.0.0.1788430756` / Swift 6.4 installation, `libswiftCompatibility56.a` and `libswiftCompatibilityPacks.a` contained arm64/arm64e but lacked x86_64, preventing macOS 12 Intel linking. Older commits failed in the same environment. Selecting SDK 26.5 alone did not help because these libraries belong to the compiler toolchain. This observation concerns that installation, not every Xcode 27 installation.

For this failure, sign in to Apple's [More Downloads](https://developer.apple.com/download/all/?q=command%20line%20tools) and install a compatible **Universal** CLT package, then rerun the check. The recorded CLT 26.6 stable download offered Apple silicon and Universal packages; this project's universal build used `Command_Line_Tools_26.6_Universal.dmg`. After installation, version `26.6.0.0.1781586589` supplied x86_64, arm64 and arm64e compatibility libraries and passed the dual-architecture preflight. Replacing CLT affects other projects using the host's default toolchain. If another full Xcode is installed, select it for one command:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer npm run build:macos-app
```

Keep the macOS 12 and dual-architecture targets. Do not bypass missing libraries, raise the minimum OS or silently switch to arm64-only. If `git describe --exact-match` finds no tag on the current commit, falling back to the version in `package.json` is normal.

## Automated verification

```sh
npm run build:macos-app -- --check-toolchain
npm run build:webui
npm run lint
npm run test:macos-app
npm run build
npm run build:macos-app
npm run test:macos-app -- --panel
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e --workspace @root/webui
```

`test:macos-app` runs a local HTTP child process in a temporary test App with a separate bundle ID, configuration, SQLite database, master-key directory and UserDefaults domain. It does not register login items, send notifications or request notification permission. Hooks compile only with `NATIVE_TESTS` and do not enter release builds. Cleanup removes test preferences, directories and backend processes owned by the test.

Automated coverage includes:

- Default creation for missing config; preservation of damaged files; preservation of unknown keys and file permissions when changing ports.
- Occupied-port fallback, IPv4/IPv6 URLs, background health checks, restart after sustained unhealthy state, graceful stop, stopping after three failed automatic restarts and manual retry.
- Menu-bar usage pulse: millisecond buckets, window totals, token totals, sparse-slot filling, out-of-range rejection, malformed envelopes, RFC3339 query encoding, compact token formatting and authenticated reads from the real `/api/admin/usage/pulse` backend.
- Reopening at overview when authenticated, ignoring and clearing old page history; an existing window keeps its page. Minimized-window restoration, geometry/theme, copy-token menu, no initial token/cookie injection, persistent WebKit storage, and releasing WebViews/message handlers on close.
- Geometry recovery after disconnecting an external display, oversized windows and partly off-screen bounds.
- Install disabled while checking updates, download progress/cancellation, HTTP errors, temporary file lifecycle, missing/mismatched digests, damaged DMGs and rollback after replacement failure.
- CoreFoundation inspection of real Mach-O fixtures: accept universal files without developer tools; reject single-architecture, invalid or missing files. Runtime validation does not invoke `lipo`.
- Stable macOS 12 LaunchAgent configuration and paths containing spaces, quotes or shell characters.

`--panel` requires a built App and uses its real universal Go backend and React WebUI. It checks the initially empty login form, token/cookie persistence after manual login, login state across window close/reopen, logout persistence, theme and overview, graceful stop/restart, port and configuration/master-key/SQLite preservation. The test App has a separate bundle ID and cleans up its WebKit store. A static preview is saved to `dist/macos-panel-preview.png` using test data; updates are neither downloaded nor installed. A locked or displayless environment can pause WebKit animation, so only the test page completes finite entrance animations before capture. This checks final layout, not unlocked animation and interaction.

`build:macos-app` compiles arm64 and x86_64 native shells targeting macOS 12, then performs:

- `lipo -verify_arch arm64 x86_64` for `ElysiaApi` and `elysia-api`.
- `plutil -lint` for Info.plist.
- `codesign --verify --deep --strict --verbose=2` for the App.
- `hdiutil verify`, a read-only DMG mount, App/architecture/signature/Applications-shortcut checks, then unmounting.

Outputs are `dist/standalone/ElysiaApi.app` and `dist/standalone/elysia-api-macos.dmg`. Builds use ad-hoc signing; signature verification is not Developer ID notarization.

## Hardware acceptance matrix

These checks require the specified OS, permission or interaction. Automated tests do not replace them.

| Area | Action and expected result |
| --- | --- |
| macOS 12 / Intel | Install the DMG; verify native x86_64 execution, WebKit panel, windows, menus and exports. |
| macOS 13+ / Apple Silicon | Launch from Applications; verify initial size, light/dark themes, standard fullscreen and reduced motion. |
| macOS 12 login item | Enable, disable and enable again; ensure one fixed-label LaunchAgent. After logout/login, show only the menu bar. Moving the App updates its path; after uninstall, the next login cleans up the old item. |
| macOS 13+ login item | Check system login items after enabling; use the menu to open system settings when approval is needed. A system-disabled item must not be silently re-enabled on launch. |
| Notifications | Allow, deny, re-enable in system settings and disable in-app. Important notifications open the window; update/failure notifications expose the update bar. Menu text explains permission status. |
| Windows and accessibility | Test ⌘W, Dock/menu reopening, minimize/fullscreen, title-bar drag/double-click and display removal. VoiceOver announces windows, status items, menus, progress and error actions. |
| System quit | Quit healthy and hung services with ⌘Q/system quit. Request graceful shutdown, then TERM after 8 seconds and KILL after another 3; leave no orphan child. Quit is temporarily disabled during installation replacement. |
| Updates | Test no update, offline, missing DMG, bad digest, cancellation, read-only destination, replacement failure and success. Preserve the old version or recoverable backup. Reopen at overview while retaining geometry, theme, config, database and key. Validation works without CLT. |
| WebKit export | Export logs, cancel saving and close the window during download. Complete the export or report a clear error; open external links in the default browser. |

## Historical verification record

The following records the environment on 2026-09-14. It does not mean later versions or this documentation change have rerun these tests.

On Apple Silicon / macOS 26.6.2 with CLT 26.6 Universal, the recorded run passed 69 native integration checks, 19 real-backend panel checks, seven browser regression cases and WebUI lint. Both `npm run build` and `npm run build:macos-app` passed, producing universal backend/shell binaries with the latest WebUI and verifying signatures, DMG integrity and mounted contents. Earlier runs reproduced missing-toolchain-library preflight failure while preserving previous outputs. Browser regressions covered distinct network/invalid-token errors, focus restoration after failure and retry with the same token. Desktop/mobile captures confirmed the protocol designer first in the system group and the removal of its title description. macOS 12/Intel hardware, logout/login, notification permissions, VoiceOver and a complete released-version update/restart still require the matrix above.

## Keyboard and logs

| Action | Shortcut |
| --- | --- |
| Close / minimize / fullscreen | ⌘W / ⌘M / ⌃⌘F |
| Show main window / preferences | ⌘0 / ⌘, |
| Reload panel | ⌘R |
| Open in browser / copy panel URL | ⇧⌘B / ⇧⌘L |
| Copy API URL / panel token | ⌥⌘C / ⇧⌥⌘C |
| Start or stop service | ⌥⌘S |
| Check updates / quit | ⇧⌘U / ⌘Q |

The menu-bar log action opens `~/Library/Application Support/ElysiaApi/elysia-api.log`. Native startup, port, health and update events go to OSLog:

```sh
log stream --predicate 'subsystem == "dev.pinkelysiadev.ElysiaApi"' --level info
```

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Intel link lacks Swift compatibility libraries | Run preflight and select CLT/Xcode with both architectures; retain the macOS 12 target |
| `--panel` cannot find the App | Run `npm run build` and `npm run build:macos-app` first |
| Captures stall without a display | Use the test's final-layout capture; verify animations/interactions separately with an unlocked display |
| Update verification fails | Inspect OSLog/runtime logs, DMG, digest, directory permissions and recovery backup; do not bypass validation |

See [deployment](deployment.en.md) for operation and data recovery.
