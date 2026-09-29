# WebUI implementation conventions

[Documentation](README.en.md) · [简体中文](webui-frontend-spec.md) · **English**

This page records the current frontend structure and interaction conventions. Documentation uses restrained formatting; the WebUI keeps its existing theme.

## Implementation sources

| Content | File |
| --- | --- |
| Theme variables and global styles | [index.css](../packages/webui/src/index.css) |
| Tailwind mappings and breakpoints | [tailwind.config.js](../packages/webui/tailwind.config.js) |
| HashRouter routes | [App.tsx](../packages/webui/src/App.tsx) |
| Layout and navigation | [app-layout.tsx](../packages/webui/src/components/app-layout.tsx) |
| Management API and types | [API](webui-api.en.md), [data model](webui-data-model.en.md) |

The frontend uses React 18, TypeScript, Vite, Tailwind, Radix, SWR and Recharts. Management requests use `/api/admin/*`; diagnostics also access `/health` and `/debug/pprof/*`, and Agent streams use the admin Agent routes. Not all traffic is ordinary JSON CRUD.

## Visual design and layout

- The porcelain / plum-ink theme uses rose for primary actions, jade for success and ember for danger. A class switches dark mode; the preference is stored in localStorage.
- At `>= 761px`, a persistent 228px sidebar is shown; at `<= 760px`, navigation uses a mobile drawer. Main padding is 40px on desktop and 22px on narrow screens. Content is capped at 1600px; runtime forms use `max-w-xl`.
- Type sizes are 11 / 12 / 13 / 14 / 16 / 19 / 30px. Fraunces 500/600 is self-hosted; other text uses system fonts. Numeric columns use tabular figures.
- Images live in `packages/webui/public`. Keep `favicon.ico`, `favicon.png` and `logo.png` paths; macOS packaging also uses `logo.png`. `logo-color.png` is the brand mark, and `role-mask.png` supplies login/overview watermarks.
- Character art aligns with the content container, at 520px on desktop and 240px on narrow screens. Login has no sidebar. Preserve reduced-motion support and login fallback when assets fail; see the [asset guide](../scripts/login-trace/README.en.md).

## Pages

These are HashRouter paths; a production URL looks like `/ui/#/overview`.

| Path | Content |
| --- | --- |
| `/login` | Panel-token login; a 401 clears authentication and returns to login |
| `/overview` | Eight KPIs, short-window RPM/latency pulse, 7/30-day trends, model charts, popular models, source health and recent failures; memory/GC cards link to diagnostics |
| `/sources` | Source CRUD, enable/disable, refresh, model filtering, capability editing and batch operations |
| `/groups` | Groups, scheduling, members and quotas; the group name is the client model ID |
| `/tokens` | Inference tokens, allowed groups, enable/disable and on-demand plaintext reveal |
| `/protocols` | Custom protocol mapping, preview, tests and saving |
| `/agent` | Assistant sessions, plans, tool progress and approvals |
| `/usage` | Request/token totals, distributions and model charts |
| `/usage-logs` | Server pagination/filtering, current-page summary, details, JSON export and Usage reset |
| `/logs` | System-event pagination, level filters and structured fields |
| `/runtime` | Runtime configuration, remote access, reload and restart notices |
| `/diagnostics` | Health, memory, pprof switch and analysis links |

## Usage display contract

- Queries share `from`, `to`, `keyName`, `groupName` and `modelName`; repeat parameter names for multiple selections. Time ranges are `[from, to)`.
- `usage/stats` aggregates requests, successes/failures, tokens and latency; `cacheHitRate` is `[0,1]`.
- `usage/trend` takes `utcOffsetMinutes` as local time minus UTC in minutes (`480` for UTC+8) and returns `{date, requests, tokens}[]`.
- `usage/by-model` returns `{model, requests, failed, tokens}[]`, sorted by descending requests then ascending model name.
- `usage/logs` accepts `status=success|failed` and `statusCode`; an exact status code takes precedence. Success means `200 <= statusCode < 400`; `499` means early client cancellation. A streaming log result may differ from the HTTP status already sent.
- Display `requestedModelGroup` as the requested model and `modelName` / `sourceId` as the actual route. Show one protocol for same-protocol forwarding.
- For `relayMode=agent-assist`, the four bodies are the internal request, forwarded request, upstream response and engine result. Bodies are not saved by default; details must distinguish absent capture, truncation and externalized media.

## Interaction and verification

Source/group/token deletion and Usage reset require confirmation. Clear plaintext secret inputs after saving; ordinary lists show masked values. Distinguish loading, empty and error states; a failed API call must not look like an empty result.

The mobile drawer closes through its button, backdrop, Esc or navigation. Restore focus on close and release scroll locking when returning to desktop. Filters support arrow keys, Enter, Esc and Tab; clearing search keeps input focus. Use semantic HTML or Radix primitives, visible focus and appropriate ARIA labels. Display time in the browser's local timezone.

See [WebUI development](../packages/webui/README.en.md) for builds, proxies and browser tests, and the [acceptance checklist](webui-acceptance.en.md) for release validation.
