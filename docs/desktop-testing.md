# 统一桌面版构建与验收

[文档](README.md) · **简体中文** · [English](desktop-testing.en.md)

统一桌面版使用 Tauri 2 管理单个窗口、托盘和 Go 子进程。窗口加载随应用打包的现有 React WebUI，桌面服务、端口、数据目录、开机启动和更新控制融入其运行设置页面；登录页通过共享设置弹窗提供相同操作。Go 仍内嵌 WebUI，供普通浏览器访问。现有服务器二进制、Docker 和 Swift macOS 生产发布继续保留；下述迁移验收完成后，才显式推广桌面产物。

本地 React 界面不依赖 Go 提供页面，服务停止或启动失败时仍可打开设置、查看状态及恢复。随应用打包的页面只获得明确列出的桌面命令权限，由 Rust 操作随包后端；Go 提供的浏览器 WebUI 不授予桌面权限。应用只启动随包 sidecar，不选择外部二进制或任意 WebUI 来源；原有数据目录仍可选择并直接复用。

## 本地构建

需要 Node.js 22+、Go 1.25+、Rust stable，以及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。Windows 使用 MSVC 和 WebView2；macOS 使用 Xcode Command Line Tools，最低系统版本为 macOS 12。Linux 在 Ubuntu 22.04 构建，安装 WebKitGTK 4.1、AppIndicator 和打包工具：

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev patchelf
```

安装 Rust 后打开新终端，确认 `cargo --version` 和 `rustc --version` 可用。Unix 当前终端可运行 `source "$HOME/.cargo/env"`；Windows 需刷新终端的 PATH。

在仓库根目录运行：

```sh
npm install
npm run test:desktop:release
npm run build:desktop -- --version 1.2.0-desktop.1
```

默认只编译当前主机架构。构建通过 `prepareWebui({ desktop: true })` 复用 React WebUI 校验与构建，将同一产物同时复制至 Go embed 目录和 `packages/desktop/frontend/ui/`，再编译所需 Go sidecar 和 Tauri 壳；版本经 Go ldflags 和临时 Tauri 配置同时注入，不改写已跟踪的版本文件。开发用后端可单独准备：

```sh
npm run build:desktop:backend
npm run dev --workspace @root/desktop
```

Tauri `dev` 先构建本地 React 页面，再加载本地资源；不额外启动 UI 开发服务器。修改界面后重新运行该命令获取最新页面。独立桌面控制页及其专属 UI 测试已取消，桌面控制与恢复流程使用原 React 组件和测试入口。

构建脚本给 Tauri 同时传入 `--ci` 和 `CI=true`，使用原生无交互打包路径。macOS DMG 保留应用和 Applications 链接，跳过需要 Finder/AppleScript 的背景与图标位置美化；锁屏或无桌面环境也使用同一路径。直接调用 Tauri 打包命令时同样设置这两个参数。

Go 新增 `--init-config`：与 `--config <path>` 一起使用，创建缺失配置或校验已有配置后退出，不启动 HTTP 服务。桌面壳通过它复用 Go 的随机面板令牌和默认配置；坏配置返回错误并保留原文件，不另造一份桌面默认配置。

服务就绪检查使用带面板令牌的 `GET /api/admin/health`，要求 `data.processID` 等于壳刚启动的子进程 PID，且 `data.database=true`。面板令牌在 WebUI 轮换后，健康探测会即时读取新令牌，保留当前监听地址，避免误判服务故障。端口探测与启动之间即使发生竞争，也不会把别人的监听服务当作自己的后端。公开 `/health` 仍用于常规健康状态与版本检查。

macOS 通用版在 macOS 主机上构建：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build:desktop -- --target universal-apple-darwin --version 1.2.0-desktop.1
```

Windows 对应目标为 `x86_64-pc-windows-msvc`、`aarch64-pc-windows-msvc`；Linux 为 `x86_64-unknown-linux-gnu`、`aarch64-unknown-linux-gnu`。在对应操作系统及架构上构建；普通本地构建关闭更新归档签名。`--updater` 启用签名更新产物，要求 `TAURI_SIGNING_PRIVATE_KEY`，加密密钥还需 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。`--update-url` 可覆盖 HTTPS 更新清单地址。

产物位于 `dist/desktop/<target>/`：

| 平台 | 安装产物 | 签名更新产物 |
| --- | --- | --- |
| macOS 通用 | `elysia-api-macos.dmg` | `elysia-api-macos.app.tar.gz` 与 `.sig` |
| Windows x64 / ARM64 | `elysia-api-desktop-windows-{amd64,arm64}-setup.exe` | 同一安装器与 `.sig` |
| Linux x64 / ARM64 | `elysia-api-desktop-linux-{amd64,arm64}.AppImage` | 同一 AppImage 与 `.sig` |

macOS 保留 `ElysiaApi.app`、`dev.pinkelysiadev.ElysiaApi`，以及 `Contents/MacOS/ElysiaApi` 和 `elysia-api`。构建校验 Info.plist 中的应用标识和主程序名；通用构建还验证两个可执行文件的双架构、ad-hoc 签名和 DMG 完整性。单架构开发包不能用于旧 Swift 更新器迁移。

## 预发布与稳定推广

GitHub Actions 的 **Build and preview unified desktop** 工作流仅手动触发，默认 `publish=false`、`promote_stable=false`。必须先配置仓库 Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`：与 `tauri.conf.json` 公钥配对的更新签名私钥内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码；未加密时为空。

私钥只保存在维护者的仓库外目录和 CI Secrets，切勿提交或打印。已有公钥对应的私钥丢失后，不能直接替换公钥继续更新旧客户端；需要由旧密钥签名的过渡版本或手动重装。更新验签密钥免费生成，不依赖商业代码签名证书。macOS 使用 ad-hoc 签名，Windows 不配置商业签名；系统首次安装提示仍需用户处理。

工作流在原生 macOS、Windows x64/ARM64、Ubuntu 22.04 x64，以及 Ubuntu 22.04 ARM64 QEMU 容器构建。五组包覆盖六个平台；更新清单的两个 macOS 架构共享通用归档。流程校验包与签名齐全后输出 `latest.json` 和 `SHA256SUMS`。

1. 使用带预发布后缀的版本，例如 `1.2.0-desktop.1`；保持 `publish=false`，下载工作流产物验收。
2. 需要分发预览时设置 `publish=true`。创建 `desktop-v<version>` 预发布，随后更新 `desktop-preview` 预发布中的清单。预览客户端读取 `https://github.com/PinkElysiaDev/Elysia-Api/releases/download/desktop-preview/latest.json`，安装包 URL 指向对应的固定版本 Release。
3. 完成下表真机与升级验收后，先通过原有发布流程创建对应稳定 `v<version>` Release。检出该 tag，运行桌面工作流，版本去掉预发布后缀并设置 `publish=true`、`promote_stable=true`。
4. 稳定推广要求目标为当前 latest、非预发布且源码提交一致。它将桌面包和 `latest.json` 加入已有 Release，显式替换旧 Swift DMG，同时合并原有服务器校验值；服务器二进制和 Docker 发布路径仍保留。稳定客户端读取 `https://github.com/PinkElysiaDev/Elysia-Api/releases/latest/download/latest.json`。

不要在验收前删除 Swift 生产壳或修改稳定入口。预览回退时先将 `desktop-preview/latest.json` 指回已验证版本，再手动重装；updater 不自动降级。正式回退同样需要已签名版本和数据兼容性检查。

macOS 安装更新前先在应用同目录备份完整 `.app`；目录不可写时拒绝安装。官方安装器失败后恢复原应用；若恢复也失败，保留完整备份并显示路径，供手动恢复。

## 自动检查与真机验收

```sh
npm run test:desktop:release
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
cd backend && go test ./...
```

已签名产物还可复用同一测试入口进行密码学验签，例如：

```sh
DESKTOP_UPDATER_ARTIFACT=dist/desktop/universal-apple-darwin/elysia-api-macos.app.tar.gz DESKTOP_UPDATER_VERSION=1.0.0-desktop.1 npm run test:desktop:release
```

此项只读取归档、`.sig` 和仓库公钥，检查内容签名、受保护的版本注释与密钥标识，不需要私钥。发布清单命令也逐一执行该验证，拒绝使用与应用公钥不配对的签名发布更新。

本机 UI 冒烟测试可用全新临时目录启动 debug 版本：

```sh
desktop_test_dir="$(mktemp -d)"
ELYSIA_DESKTOP_TEST_ROOT="$desktop_test_dir" npm run dev --workspace @root/desktop
```

`ELYSIA_DESKTOP_TEST_ROOT` **仅 debug 编译生效**：将 `desktop.json` 放在该目录，首次数据目录设为其 `data/`，跳过旧开机启动迁移和自动更新检查，并拒绝修改系统开机启动项。使用全新目录；其中已有偏好仍可能指向用户手动选择的数据目录。release 包忽略该变量，不能用它隔离正式安装。WebView 登录存储、系统注册和实际升级仍需单独验收。应用明确退出后可删除该临时目录。

macOS 通用包构建完成后，还可运行 `node scripts/test-desktop-macos-migration.mjs --dmg <本地DMG路径>`，在一次性目录中调用旧 Swift 的真实安装器验证包校验、提取和整体替换，检查数据哨兵保持原字节。此项仅验证旧安装器与新包的兼容性，不代表网络更新、目标 UI 或开机启动迁移已通过。

发布脚本检查覆盖 SemVer、主机与目标映射、六平台清单、通用更新归档、缺包/坏签名拒绝、旧服务器校验值保留、非法文件名及不兼容 macOS 标识拒绝。签名检查验证完整 Minisign 格式及其版本字段与清单一致；客户端启用 `requireSignedVersion`，真正的密码学验签由 Tauri signer/updater 完成。Rust、Go 检查与构建成功不能替代下列验收。

| 范围 | 操作与通过条件 |
| --- | --- |
| 三端双架构 | 在 macOS Intel/Apple Silicon、Windows x64/ARM64、Linux x64/ARM64 安装和双击，窗口可用且不弹出终端；Linux 分别验证有托盘、无托盘环境。 |
| 单实例与后台 | 重复打开只恢复原窗口；关闭窗口服务继续运行；无托盘时最小化仍可恢复；退出应用后无自有 Go 遗留进程。 |
| 固定端口 | 占用 8765 或已配置端口，显示冲突，可重试或改配置；不接管外部进程；已有配置优先。 |
| 生命周期 | 手动停止不重启；异常退出至多恢复三次；终止壳后 stdin EOF 使自有 Go 子进程退出；正常停止等待数据库、日志与流式请求收尾。 |
| 数据接入 | macOS 原目录直接复用；Windows/Linux 首次选旧目录；配置、SQLite、主密钥、附件、模型源和自定义路径完整，损坏配置保持原文件。使用备份测试数据，勿并发打开同一数据库。 |
| 开机启动 | 从旧 Swift 注册迁移到新项后只启动一个实例；旧项无法注销时显示系统设置指引且不新增重复项；禁用后下次登录不启动。 |
| 面板 | 初始空登录表单，复制令牌后手动登录；窗口重开、登出、流式调用、文件下载导出、复制粘贴与外部链接正常。 |
| 令牌轮换 | 在 WebUI 运行设置中更新面板令牌；健康探测使用新令牌，服务不因缓存旧令牌误报故障或重启，当前监听地址保持原值。 |
| 统一设置与恢复 | 单个窗口呈现 React 控制台；运行设置页和登录页共享设置弹窗中的桌面控制一致。停止服务后本地 React 仍运行，可修改端口、选择旧数据目录、重新启动和检查更新。 |
| 权限边界 | 随应用打包的 React 页面只能调用授权桌面命令；直接在浏览器打开 Go `/ui/` 无桌面控制与原生命令权限，外部链接交给系统浏览器。 |
| 更新失败 | 断网、无更新、取消下载、错误签名、不可写目录、服务无法停止时，当前版本与数据可继续使用；签名验证失败不停止服务。 |
| 更新成功 | 下载验签完成且自有服务退出后才安装整包；Windows 安装器退出前也完成关停；重启后 Go `/health`、Tauri 和 WebUI 属于同一发布版本。 |
| 两次实际升级 | 从旧 Swift 安装包升级到通用 Tauri 包，再从一个 Tauri 版本更新到下一版；登录状态、配置、SQLite、密钥和附件可用。记录每个 OS/架构、源版本、目标版本和结果。 |

真机检查未完成时，记录为“待验证”，保持预发布状态。

## 本地验收记录

2026-10-01，macOS Apple Silicon，隔离 debug 应用标识 `.NativeTest`：单窗口 React 原生登录、菜单、运行设置页、停止后保留侧栏、修改固定端口并重启、pprof Blob 下载、重复启动、关闭重开、明确退出无遗留进程，以及父进程 SIGKILL 后 stdin EOF 使子进程退出均已实测。

实际轮换运行中的面板令牌后，持续观察 35 秒：Go 保持同一健康进程，桌面状态保持运行中；旧前端登录按 401 正常退出。

使用签名 loopback 更新夹具验证：错误签名、取消和离线保持同一 Go 进程；带 AppleDouble 的测试归档安装失败后，保护备份实际恢复原 `.app` 并重启后端。去掉 AppleDouble 后，`.1→.2` 升级成功，React、原生版本与 Go 健康版本一致，登录状态保留，配置、密钥及附件哈希不变，数据库健康。此项属于隔离本地升级测试，并非正式网络 Release 升级。

正式通用包已通过旧 Swift 安装器的校验、提取、替换及字节哨兵兼容检查。旧 Swift 的整套网络、界面和开机启动迁移，macOS Intel 真机，Windows/Linux 双架构真机与开机启动仍待验收。维护者尚需配置 CI Secrets；本次未发布。
