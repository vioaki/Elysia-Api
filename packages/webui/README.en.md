# Elysia API WebUI

[Documentation](../../docs/README.en.md) · [简体中文](README.md) · **English**

A React 18 + TypeScript management interface using Vite, Tailwind, Radix, SWR, Recharts and HashRouter. Production assets run at `/ui/` without a separate frontend service. The theme supports light, dark and system preferences.

## Features

Manage sources, source models, groups, inference tokens, custom protocols and runtime settings. Inspect usage, request logs, system events and diagnostics. Use the built-in assistant for permission-controlled management tasks.

Request details can show four bodies: inbound, forwarded, upstream response and downstream response. Saving depends on configuration; bodies are not saved by default. On-demand token reveal requires administrator access. See [WebUI conventions](../../docs/webui-frontend-spec.en.md) for pages and interactions.

## Prerequisites

Use Node.js 22, npm and Go 1.25. Run the following commands from the repository root unless specified. Run `npm install` for initial setup; see the [development guide](../../docs/development.en.md) for the full environment.

## Local development

1. Start the backend in one terminal:

   ```sh
   cd backend
   go run . --config ./config.json
   ```

2. Start the frontend from the repository root in another terminal:

   ```sh
   npm run dev --workspace @root/webui
   ```

3. Open `http://127.0.0.1:5273/` and log in with `panelAccessToken` from the backend configuration.

Vite listens on loopback by default. Override the backend with `ELYSIA_DEV_PROXY` and the frontend bind address with `ELYSIA_DEV_HOST`. For a non-default backend:

```sh
ELYSIA_DEV_PROXY=http://127.0.0.1:8799 npm run dev --workspace @root/webui
```

Proxies cover `/api`, `/v1` (also matching `/v1beta`), `/health`, `/mcp`, `/a2a`, `/.well-known/agent-card.json` and `/debug`.

## Build

```sh
npm run build:webui
```

Output is `packages/webui/dist/`. This command verifies login assets, then runs TypeScript and Vite. `npm run build` also copies assets into `backend/webui/dist/` and embeds them in release binaries.

To serve an external frontend build, point the backend `webuiDir` at that directory. Relative paths resolve from the configuration directory. The backend serves static files at `/ui/` without a history fallback, so keep HashRouter.

## Verification

```sh
npm run lint --workspace @root/webui
npm run build:webui
npm exec --workspace @root/webui playwright install chromium
npm run test:e2e --workspace @root/webui
```

Browser tests start the frontend at `127.0.0.1:5274` with mock responses and test tokens; no real backend is required. They cover pagination, page correction after cleanup, retries, navigation focus, filter keyboard controls, Agent streams and narrow layouts in both themes. With Chrome installed, use `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e --workspace @root/webui`.

See the [acceptance checklist](../../docs/webui-acceptance.en.md) for manual checks and [trace production](../../scripts/login-trace/README.en.md) for asset edits.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Login connection failure | Backend running and proxy address matching the actual port |
| 401 | Use the panel token and verify the configuration path; inference tokens cannot administer the panel |
| Blank page or asset 404 | Serve the production build at `/ui/`; check `webuiDir` and complete output |
| Asset hash mismatch during build | Synchronize exported traces and version files; do not bypass verification |
| Browser tests cannot start | Install Playwright Chromium or select an installed browser channel; check port 5274 |
