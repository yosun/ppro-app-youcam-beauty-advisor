# Specification files

Generated from the code by `npm run spec:build`; `npm run spec:check` fails CI
if they are stale. Do not edit them by hand. The prose standard is
[docs/PPRO-APP-API.md](../docs/PPRO-APP-API.md).

| File | What it is |
| --- | --- |
| `openapi.yaml` | The HTTP API, OpenAPI 3.1. |
| `schemas/manifest.schema.json` | What a ppro-app publishes at `/.well-known/ppro-app.json`. Validate any app's manifest against it. |
| `schemas/session.schema.json` | The session snapshot. |
| `schemas/event.schema.json` | Every event, as a `oneOf`. |
| `schemas/tool-response.schema.json` | What a tool call returns. |
| `schemas/requests.schema.json` | The request bodies. |
| `schemas/tools/<name>.json` | One tool's arguments (18 tools). |
| `manifest.example.json` | This app's manifest, as a worked example. |

Protocol identifier: `ppro-app/1`. 15 event types.
