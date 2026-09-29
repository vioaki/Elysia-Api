# WebUI acceptance checklist

[Documentation](README.en.md) · [简体中文](webui-acceptance.md) · **English**

## Prerequisites and procedure

- Use temporary configuration, database, keys and test tokens. Record the version, OS, browser and date. Do not reset production Usage.
- Run the automated checks in the development guide first, then verify the items below. Checkboxes are pending checks, not evidence that the current version has passed.
- Use local mock upstreams first. Live provider tests require separate credentials and an explicit usage decision.

## Basic operation

- [ ] Run a release binary, open `/ui/` and log in with `panelAccessToken`, without an extra launcher.
- [ ] First launch creates configuration; default database and master key are beside it. Invalid configuration must fail without overwriting the file.
- [ ] Verify reload after changing `logLevel` or `httpTimeout`, and restart notices after changing `host`, `port`, `databasePath` or `enablePprof`.
- [ ] An ordinary binary reports an occupied port; the macOS App uses its port fallback policy.

## Source coverage

- [ ] Verify model discovery and failure reporting for Chat Completions, Responses, Anthropic and Gemini. Test compatible services against their actual model-list endpoint.
- [ ] Failed refreshes or empty upstream lists preserve the existing cache and show the reason.
- [ ] Manual sources accept multiple models; disabled sources do not participate in refresh or routing.
- [ ] Custom sources with `models` can verify discovery; otherwise use manual models.
- [ ] Refresh preserves manually edited model capabilities.

## Group coverage

- [ ] Create an LLM group and verify `round-robin`, `sequential` and `random`, distinguishing rotation, failure fallback and random starting points.
- [ ] Configure and verify `maxRetries`, `retryInterval`, `maxConcurrency`, `dailyLimitMaxRequests` and `dailyLimitMaxTokens`.
- [ ] `/v1/models` and `/v1beta/models` list enabled groups accessible to the token; requests by group name route to members.
- [ ] After renaming, check client model names and token grants; deleting a token's last allowed group disables it according to policy.

## Tokens and permissions

- [ ] Inference tokens support create, disable, update and delete; unauthenticated admin and inference requests return 401.
- [ ] Panel tokens, inference tokens and Agent keys have separate roles; Agent keys cannot run inference, and missing remote scopes return 403.
- [ ] Ordinary lists and system logs do not leak keys; plaintext reveal and the runtime-config panel token are administrator-only.
- [ ] When the master key loads, verify encrypted sensitive fields in SQLite; on key failure, inspect warnings rather than treating fallback as encryption success.
- [ ] Verify ask/always/never and plan mode through REST/A2A; MCP executes without those approvals, so check its scopes and outbound restrictions separately.

## Usage and logs

- [ ] Streaming and non-streaming calls record usage; bodies are off by default. When enabled, verify capture limits, truncation and externalized-media markers.
- [ ] Pagination, multi-select filters, half-open time ranges and status filters agree with statistics; distinguish failures, client cancellation and empty results.
- [ ] Reset Usage in a test database and verify statistics/page updates; verify retention-age, row-count and size cleanup conditions.
- [ ] System logs show refresh/error events; exports match records and capture policy.

## Frontend and accessibility

- [ ] In both themes, desktop, the 760/761px breakpoint and narrow screens, tables, dialogs, drawers and long content remain readable and usable.
- [ ] Complete login, navigation, filtering and confirmation by keyboard; verify Esc, focus restoration, screen-reader labels and reduced motion.
- [ ] Network and token failures have distinct messages; asset failure does not block an authenticated login.

## Standalone distribution

- [ ] Run `npm run build` from the repository root to create six platform/architecture binaries in `dist/standalone`.
- [ ] Keep `config.json.example` at the root; the release directory contains neither this template nor local config, SQLite/WAL or master keys.
- [ ] Binaries embed the latest WebUI; check the macOS App/DMG with the native guide, without treating ad-hoc signing as notarization.

## Failure records

Record reproduction steps, expected/actual results, redacted logs and environment. Start with [deployment troubleshooting](deployment.en.md#troubleshooting), then rerun affected checks. See [development](development.en.md) for automation and [macOS testing](macos-testing.en.md) for native checks.
