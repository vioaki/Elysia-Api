# WebUI 实现约定

[文档首页](README.md) · **简体中文** · [English](webui-frontend-spec.en.md)

本文记录当前前端结构与交互约定。文档采用简洁排版；WebUI 继续使用现有主题。

<a id="source-of-truth"></a>

## 实现来源

| 内容 | 文件 |
| --- | --- |
| 主题变量与全局样式 | [index.css](../packages/webui/src/index.css) |
| Tailwind 映射与断点 | [tailwind.config.js](../packages/webui/tailwind.config.js) |
| HashRouter 路由 | [App.tsx](../packages/webui/src/App.tsx) |
| 布局与导航 | [app-layout.tsx](../packages/webui/src/components/app-layout.tsx) |
| 管理 API 与数据类型 | [接口](webui-api.md)、[数据模型](webui-data-model.md) |

前端使用 React 18、TypeScript、Vite、Tailwind、Radix、SWR、Recharts。管理请求使用 `/api/admin/*`，诊断还会访问 `/health`、`/debug/pprof/*`；Agent 流使用管理端 Agent 路由。不能将所有通信都假定为普通 JSON CRUD。

<a id="visual-and-layout"></a>

## 视觉与布局

- 主题为 porcelain / plum-ink，使用 rose 主色、jade 成功色和 ember 危险色。深色通过 class 切换，选择保存在 localStorage。
- `>= 761px` 显示 228px 常驻侧栏；`<= 760px` 使用移动抽屉。主栏内边距桌面 40px、窄屏 22px；内容宽度上限 1600px，运行配置表单使用 `max-w-xl`。
- 字号层级为 11 / 12 / 13 / 14 / 16 / 19 / 30px。Fraunces 500/600 自托管，其余使用系统字体栈。数字列使用等宽数字。
- 图片位于 `packages/webui/public`。保留 `favicon.ico`、`favicon.png`、`logo.png` 路径；macOS 打包也使用 `logo.png`。`logo-color.png` 用作品牌标识，`role-mask.png` 用于登录和总览水印。
- 立绘与内容容器对齐，桌面宽 520px、窄屏宽 240px。登录无侧栏。保留减少动态效果支持与素材失败时的登录回退，素材流程见[制作指南](../scripts/login-trace/README.md)。

<a id="pages"></a>

## 页面

以下为 HashRouter 内部路径；生产地址例如 `/ui/#/overview`。

| 路径 | 内容 |
| --- | --- |
| `/login` | 面板令牌登录；401 时清除登录态并返回登录页 |
| `/overview` | 8 格 KPI、短窗 RPM/时延脉搏、7/30 日趋势、模型调用图、热门模型、模型源健康、最近失败；内存/GC 卡跳转诊断 |
| `/sources` | 模型源增删改、启停、刷新；源内模型筛选、能力编辑与批量操作 |
| `/groups` | 模型组、调度策略、成员与限额；组名是客户端模型 ID |
| `/tokens` | 推理令牌、允许组、启停与按需明文查看 |
| `/protocols` | 自定义协议映射、预览、测试和保存 |
| `/agent` | 助手会话、计划、工具进度和审批 |
| `/usage` | 请求与 token 汇总、分布和模型图表 |
| `/usage-logs` | 服务端分页筛选、当前页摘要、详情、JSON 导出与 Usage 重置 |
| `/logs` | 系统事件分页、级别筛选和结构化字段 |
| `/runtime` | 运行配置、远程访问设置、热重载与重启提示 |
| `/diagnostics` | 健康、内存、pprof 开关与分析入口 |

<a id="usage-api-contracts"></a>

## 用量显示契约

- 查询复用 `from`、`to`、`keyName`、`groupName`、`modelName`；多选值重复发送同名参数。时间范围为 `[from, to)`。
- `usage/stats` 汇总请求、成功/失败、token、耗时；`cacheHitRate` 为 `[0,1]`。
- `usage/trend` 使用 `utcOffsetMinutes` 表示本地相对 UTC 的分钟偏移，东八区为 `480`；返回 `{date, requests, tokens}[]`。
- `usage/by-model` 返回 `{model, requests, failed, tokens}[]`，按请求数降序、模型名升序。
- `usage/logs` 支持 `status=success|failed` 和 `statusCode`，同时提供时精确状态码优先。`200 <= statusCode < 400` 为成功，`499` 表示客户端提前取消；流式日志结果码可能不同于已发送的 HTTP 状态码。
- 请求模型显示 `requestedModelGroup`，实际路由显示 `modelName` / `sourceId`。同协议链路只显示一个协议。
- `relayMode=agent-assist` 的四段正文对应内部请求、后端转发、上游返回和交给引擎的结果。正文默认不保存；详情应准确显示未捕获、截断和媒体外置状态。

<a id="ux-requirements"></a>

## 交互与验证

删除模型源、组、令牌及重置 Usage 需要二次确认。密钥输入保存后清空；普通列表只展示脱敏值。数据区区分加载、空数据和错误，接口失败不能显示为正常空列表。

移动抽屉支持关闭按钮、遮罩、Esc 和导航跳转关闭；关闭后恢复焦点，切回桌面解除滚动锁定。筛选支持方向键、Enter、Esc、Tab；清空搜索后保留输入焦点。交互使用语义 HTML 或 Radix primitive，保留可见焦点和必要的 ARIA label。时间按浏览器本地时区展示。

构建、开发代理与浏览器测试见 [WebUI 开发](../packages/webui/README.md)。发布验收见[检查清单](webui-acceptance.md)。
