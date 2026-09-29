# DashScope 接入

[文档索引](README.md) · **简体中文** · [English](custom-protocol-dashscope.en.md)

优先使用百炼的 OpenAI 兼容端点。仅在需要原生路径或参数时配置自定义协议。需要有效的 DashScope API Key、可用模型及对应地域的服务地址。

<a id="方式一推荐openai-兼容模式零配置"></a>

## OpenAI 兼容模式

1. 创建模型源，协议选择 Chat Completions API。
2. 中国内地常见 Base URL 为 `https://dashscope.aliyuncs.com/compatible-mode/v1`；其他地域使用其对应地址与 Key。
3. 填入 API Key，拉取模型或手工添加账户可用模型。
4. 将模型加入模型组，用推理令牌分别验证普通请求和流式请求。

本模式使用内置 Chat Completions 路径，不需要自定义定义。具体模型能力、权限和计费以供应商账户为准。

<a id="方式二native-generation-协议自定义协议模板"></a>

## 原生 Generation 模式

在设计器创建以下定义。源 Base URL 使用 `https://dashscope.aliyuncs.com`，模型手工填写账户可用 ID，例如 `qwen-plus`：

```json
{
  "id": "dashscope-native",
  "name": "DashScope Generation",
  "version": "1",
  "type": "llm",
  "request": {
    "method": "POST",
    "path": "/api/v1/services/aigc/text-generation/generation",
    "shape": "openai-chat",
    "headers": {"X-DashScope-SSE":"enable"},
    "body": {
      "model": {"field":"model"},
      "input": {"messages":{"field":"messages","mode":"json"}},
      "parameters": {"incremental_output":{"value":true},"result_format":{"value":"message"}}
    }
  },
  "response": {
    "idPath": "request_id",
    "textPath": "output.choices[0].message.content",
    "usagePath": "usage",
    "finishReasonPath": "output.choices[0].finish_reason",
    "stream": {"mode":"delta"}
  }
}
```

该定义始终发送 SSE 请求头，适用于流式调用（`stream: true`）。原生非流式定义需移除 `X-DashScope-SSE` 并将 `incremental_output` 设为 `false`，再预览和测试 JSON 响应。需要同一源同时处理两种模式时，优先使用兼容模式。

此示例选择 `incremental_output: true`，因此使用 `delta`。若实际模型返回累计全文，使用 `incremental_output: false` 并将流模式改为 `cumulative`；不能让开关和解码模式相互矛盾。通过设计器的上游事件采样确认实际行为。

`result_format: message` 对应 `output.choices[0].message.content`，对象数组中的文本会被提取。若使用 text 格式，应改用实际返回的 `output.text` 路径。`usage` 的 `input_tokens` / `output_tokens` 有内置别名。

该示例不声明模型发现，需关闭该源自动拉取。多模态模型可能使用不同的原生端点；请按目标模型的供应商文档确认路径及请求、响应结构，不能只替换路径就假定兼容。

<a id="流式行为说明"></a>
<a id="异构帧协议streamframes"></a>

## 流式终止与异构帧

显式 finish reason 后允许空补全；只有 `[DONE]`、无输出且无 finish reason 的流失败。结束后短暂排水继续采集 usage 尾帧。

事件形状不同时，在 `response.stream.frames` 按事件名或 Match 分别映射。下面为 Responses 风格的示意片段，**不是 DashScope Generation 配置**：

```json
{
  "response": {
    "stream": {
      "frames": [
        {"event":"response.output_text.delta","response":{"textPath":"delta"}},
        {"event":"response.reasoning_text.delta","response":{"reasoningPath":"delta"}},
        {"event":"response.completed","terminal":true,"payloadPath":"response","response":{"usagePath":"usage"}}
      ]
    }
  }
}
```

首个匹配规则生效，未匹配帧跳过；帧内响应不能嵌套 `stream`。需要兜底时添加通用 Match。更多模式、工具拼装、签名和终止条件见[定义参考](protocol-definition-reference.md)。

<a id="故障排查502completed-without-representable-output"></a>

## 故障处理

| 现象 | 检查 |
| --- | --- |
| 401 / 403 | Key 的地域、权限、源配置与账户状态 |
| 没有正文 | `result_format` 是否与路径一致；`payloadPath` 是否错误 |
| 文本重复或缺失 | `delta` / `cumulative` 与上游实际增量语义是否匹配 |
| `completed without representable output` | 是否映射到正文、工具或 finish reason；对照上游采样和解码事件 |
| 旧配置流映射为空 | 空 `stream.response` 会继承外层映射；仍需检查实际路径 |
| 流末尾报错 | 是否遗漏终止条件、finish reason 或 error 帧映射 |

<a id="已知不适用场景"></a>

## 验证与边界

在 `backend/` 运行本地合成上游回归：

```bash
go test ./server -run '^TestChatCompletionsDashscopeNativeStreamingEndToEnd$' -count=1
```

此测试验证累计快照、请求头和字段映射的本地处理，不是当前供应商在线验收。上例采用增量模式，真实接入仍需用目标模型检查普通/流式响应、usage 与错误。

单帧需为可解析 JSON 或已配置终止字面量；不支持将任意碎片 JSON 或二进制流自动拼为事件。示例只映射第一个 choice；多 choice、工具、多模态和推理输出需要相应定义，不能据此宣称完整兼容。
