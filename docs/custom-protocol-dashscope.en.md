# DashScope integration

[Documentation](README.en.md) · [简体中文](custom-protocol-dashscope.md) · **English**

Prefer DashScope's OpenAI-compatible endpoint. Use a custom definition only for native paths or parameters. You need a valid API key, an available model, and the service address matching its region.

## OpenAI-compatible mode

1. Create a source using Chat Completions API.
2. The mainland China Base URL commonly used is `https://dashscope.aliyuncs.com/compatible-mode/v1`; use the corresponding address and key for other regions.
3. Enter the API key and fetch models or add an account-accessible model manually.
4. Add it to a group and test both ordinary and streaming requests with a relay token.

This mode uses the built-in Chat Completions path and needs no custom definition. Model capabilities, access, and charges depend on the provider account.

## Native Generation mode

Create this definition in the designer. Use source Base URL `https://dashscope.aliyuncs.com` and manually add an account-accessible model ID, such as `qwen-plus`:

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

This definition enables the SSE header on every request and is intended for streaming calls (`stream: true`). For a non-streaming native definition, remove `X-DashScope-SSE` and set `incremental_output` to `false`, then preview and test the JSON response. Use compatible mode when both modes should share one source.

This example selects `incremental_output: true` and therefore uses `delta`. If the model returns cumulative text, use `incremental_output: false` with `cumulative` mode. Do not mix contradictory settings. Inspect sampled upstream events in the designer to confirm actual behavior.

`result_format: message` corresponds to `output.choices[0].message.content`; text is extracted from object arrays. Text-format responses require the actual `output.text` path instead. `usage.input_tokens` / `output_tokens` have built-in aliases.

The example defines no discovery endpoint, so disable automatic fetching for the source. Multimodal models may use a different native endpoint. Check the target model's provider documentation for its path and request/response shapes; replacing the path alone does not establish compatibility.

## Completion and heterogeneous frames

An explicit finish reason allows an empty completion. A stream containing only `[DONE]`, without output or a finish reason, fails. A short drain period collects usage tail frames after completion.

Use `response.stream.frames` when event shapes differ. This illustrates Responses-style events and is **not a DashScope Generation configuration**:

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

The first matching rule wins and unmatched frames are skipped. Frame responses cannot nest `stream`. Add a general Match for fallback handling. See the [definition reference](protocol-definition-reference.en.md) for modes, tool assembly, signatures, and completion.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| 401 / 403 | Key region, permissions, source settings, account state |
| Missing text | `result_format` versus extraction path; incorrect `payloadPath` |
| Repeated or missing text | `delta` / `cumulative` versus actual upstream semantics |
| `completed without representable output` | Mappings for text, tools, or finish reason; compare sampled and decoded events |
| Empty mapping in old configuration | Empty `stream.response` inherits the outer mapping; actual paths still need checking |
| Error at stream end | Missing completion, finish reason, or error mapping |

## Validation and limits

Run the synthetic-upstream regression from `backend/`:

```bash
go test ./server -run '^TestChatCompletionsDashscopeNativeStreamingEndToEnd$' -count=1
```

This test checks local handling of cumulative snapshots, headers, and mappings; it is not live provider acceptance. The example above selects delta mode. Validate ordinary/streaming responses, usage, and errors against the actual target model.

Frames must be parseable JSON or configured terminal literals; arbitrary fragmented JSON and binary streams are not automatically assembled into events. The example maps only the first choice. Multiple choices, tools, multimodal output, and reasoning require appropriate definitions and are not covered by a blanket compatibility claim.
