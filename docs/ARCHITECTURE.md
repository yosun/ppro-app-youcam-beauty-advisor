# Architecture

How the code is organized, what happens when an agent calls a tool, and where a host product plugs in. The rules of the API are in [PPRO-APP-API.md](PPRO-APP-API.md). This page is about the implementation.

## Shape

One Node process serves the web app, the HTTP API and the MCP endpoint. All three sit on one `Runtime`, which holds every session in memory and knows the beauty advisor only through an `AppDefinition`.

```
 client's browser            one Node process                          your agent
 ┌──────────────┐     ┌───────────────────────────────┐     ┌────────────────────────┐
 │  React app   │────►│ HTTP routes (Hono)            │◄────│ HTTP / SSE (SDK, curl) │
 │  (src/web)   │     │ MCP adapter                   │◄────│ MCP client             │
 └──────────────┘     │        │                      │     └────────────────────────┘
                      │        ▼                      │
 your backend         │ Runtime: sessions, events,    │
 ┌──────────────┐     │ photos, consent, UI state,    │
 │ HostClient   │────►│ the tool pipeline             │
 └──────────────┘     │        │ AppDefinition        │
                      │        ▼                      │
                      │ the beauty advisor: tools,    │──────► YouCam AI (HTTPS)
                      │ screens, state, briefing      │
                      └───────────────────────────────┘
```

## Layers

| Directory      | What is in it                                                                                                                      | May import                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/protocol` | The standard: types, Zod schemas, the manifest and OpenAPI builders, error codes, text hygiene, and the `AppDefinition` interface. | nothing                                                            |
| `src/support`  | Environment readers, and the image decoder: the one place a client's bytes are decoded.                                            | `protocol`                                                         |
| `src/advisor`  | The beauty advisor: 10 tools, the YouCam client, result readers, screens and targets, the briefing.                                | `protocol`, `support`                                              |
| `src/server`   | The runtime (sessions, events, the tool pipeline), HTTP routes, the MCP adapter, static files, config, tokens and rate limits.     | `protocol`, `support`; `advisor` only in `main.ts`, which wires it |
| `src/client`   | The TypeScript SDK: `AdvisorClient` for the agent and the client, `HostClient` for the host.                                       | `protocol`, and the advisor's state types                          |
| `src/web`      | The React app the client sees.                                                                                                     | `protocol`, `client`, `advisor`                                    |

`tests/meta.test.ts` enforces these edges. It also keeps `protocol`, `client` and `web` free of Node-only modules, because the browser bundles them.

Outside `src`: `spec/` is generated from the code (`npm run spec:build`) and `npm run spec:check` fails CI if it is stale. `examples/` holds a scripted advisor and an LLM-driven one. `e2e/` holds the browser tests.

## The seam: `AppDefinition`

[`src/protocol/app-definition.ts`](../src/protocol/app-definition.ts) is everything the runtime knows about an app.

- **Identity and rules**: id, name, version, the provider, the disclaimer, the advisor's guardrails, the starter prompts.
- **Screens and targets**: the screens, the target grammar (`skin:pore`, `shade:1`), and `resolveTarget`, `availableScreens`, `validTargets`.
- **State**: `initialState`, a JSON Schema for the manifest, `summarize` for `get_session_state`, and `dropMedia` to forget photos and images that were deleted.
- **Tools**: each is written with `defineTool`: a Zod schema for its arguments, a description written for the model, its cost, whether it `needsPhoto` or `usesEngine`, and `run`.
- **The briefing**: `instructions()` renders the advisor's system prompt for a session as it stands.

A tool never touches a session. `run(ctx, args)` receives a read-only `ToolContext` (the state, the UI, consent, a photo by id, `saveImage`) and returns a `ToolRun`: a compact `result` for the agent, an optional transcript `entry`, a `patch(state)` function, a UI patch, and the `units` to charge. The runtime applies the patch to a copy and commits it in one step, so a snapshot is never half updated and a failed tool changes nothing.

## A tool call

1. A route authenticates the bearer token, checks it is an agent token and hands the tool name and arguments to `Runtime.invoke`. That method implements `say`, `set_presence`, `get_session_state`, `wait_for_events` and `end_session` itself and sends every other name to `callTool`. MCP calls go through the same method.
2. `callTool` finds the tool (`404 unknown_tool`), takes a token from the session's tool-call bucket (40 a minute, then `429`) and validates the arguments against the tool's schema (`422 invalid_arguments`, naming the argument).
3. With an `Idempotency-Key`, a repeat with the same arguments replays the first response and sets `Idempotent-Replayed`. The same key with different arguments is `409`. The session remembers 200 keys.
4. The call joins the session's queue. A session runs one tool at a time, in arrival order.
5. `runTool` refuses, as a normal `ok: false` result and not an HTTP error, a photo tool when consent is missing (`consent_required`) or no photo is shared (`no_photo`), an engine tool when YouCam is switched off (`unavailable`), and any tool that costs more than the budget left (`budget_exhausted`).
6. The runtime emits `tool.started` and runs the tool. If it throws, the agent gets a retryable `tool_error` and the log gets the error's name only, never its message.
7. On success the runtime charges the units (`budget.updated`), appends the transcript entry, commits the state patch (one `app.updated` per top-level part that changed) and applies the UI patch (`ui.changed`). Then it emits `tool.completed`.
8. The response carries the new `rev` and `unitsRemaining`.

If the session ends while a tool is working, the result is discarded and the images it made are cleared.

## Events and the web app

A session is a snapshot plus a log of events with a rising `rev`. The log is a ring of 500; asking for events older than that is `410 events_expired`, and the caller reads the snapshot and resumes from its `rev`. `waitForEvents` chooses the events and reads `rev` and `phase` in the same step, so the `rev` it returns is a safe place to resume: nothing before it is missing and nothing after it was skipped.

The web app keeps no state the server does not have. `use-session` loads a snapshot and applies events with `apply-event.ts`, a pure function. `tests/apply-event.test.ts` proves that a snapshot plus the events that follow equals a fresh snapshot. What the client does (switch tabs, copy a shade, save the look) goes to the server as a UI event and comes back as an event, so the agent sees it.

## Where the safety properties live

| Property                                               | Enforced in                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No photo tool runs without the client's consent        | `Runtime.runTool`. No agent route sets consent; only the client, or a host that attests it collected consent, can.                                          |
| A photo is decoded once, then re-encoded and bounded   | `support/image.ts`: the format is read from the bytes, size and pixel limits apply before a decoder allocates, EXIF, GPS and alpha are dropped.             |
| Photos stay in memory and are deleted at the end       | `server/session.ts` holds them in maps. `Runtime.end`, `deletePhoto` and the app's `dropMedia` clear them.                                                  |
| Age, gender and ethnicity never reach the agent        | The result readers in `advisor/analysis.ts`.                                                                                                                |
| Agent text is plain, and spoken text is speakable      | `protocol/text.ts`: links, markdown and emoji are removed; `spoken` ends on a sentence. A narrow content floor refuses sexual content.                      |
| Tokens                                                 | `server/tokens.ts`: HMAC-SHA256, bound to one session and one role, compared in constant time. `server/http.ts` reads the header only.                      |
| A token for another session learns nothing             | `server/http.ts` answers `404`, not `403`, where `403` would confirm the session exists.                                                                    |
| Budgets and rate limits                                | `Runtime.runTool` (per session), `advisor/limits.ts` (daily task cap), `server/rate-limit.ts`.                                                              |
| A bad response from YouCam cannot aim a request inward | `advisor/youcam.ts`: links must be public https hosts, result images come only from YouCam's storage hosts, redirects are off, sizes and times are bounded. |
| Framing, CORS and caching                              | `server/app.ts`: `frame-ancestors` lists only the allowed origins, CORS answers only them (the manifest is open), the API is `no-store`.                    |
| The page around the app sees almost nothing            | `web/host-bridge.ts`: three outgoing messages, one incoming, exact origins.                                                                                 |

## What a host keeps to itself

The app is one professional tool. A product that offers it to people also has things this repository does not contain and should not:

- **Accounts, sign-in, payments and bookings.** The host decides who may start a consultation and for how long (`minutes`).
- **The advisor's runtime.** The LLM, its memory and its voice live outside. The app gives the agent a briefing, tools and events.
- **Voice and video.** The app exposes the advisor's `spoken` text and `presence` states. Turning the client's speech into text, and the advisor's text into voice or an avatar, is the host's job.
- **Records.** Sessions are in memory. A host that wants a transcript reads it with `GET …/transcript.txt` while the session lives or within ten minutes after it ends, and stores it with its own data.
- **Who the advisor is.** Name, pronouns and persona come from the host when it creates the session.

| You want to…                                   | Use                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Start a consultation                           | `POST /ppro/v1/sessions` with the host key (`HostClient.createSession`)               |
| Give the advisor a personality                 | `advisor.persona`. The client never sees it and it cannot override the safety rules.  |
| Skip the consent card because you collected it | `consent: { adult, photo_analysis }` when you create the session                      |
| Embed the app                                  | An iframe with `allow="camera"`, `host_origin` on the session, `PPRO_ALLOWED_ORIGINS` |
| Drive your own avatar or voice                 | Listen to `message.created` (its `spoken` field) and `presence.changed`               |
| Feed the client's speech in                    | `POST …/messages` with the host key and `role: "client"`                              |
| Link products your way                         | `PPRO_PRODUCT_LINK_TEMPLATE`                                                          |
| End a consultation early                       | `DELETE /ppro/v1/sessions/{id}` with the host key                                     |

The [host guide](HOST-GUIDE.md) walks through each.

## A second app

Nothing in `src/protocol` or `src/server` names the beauty advisor, except the line in `server/main.ts` that passes it to `Runtime`. A second ppro-app is a new `AppDefinition` plus its own screens. This path has not been exercised with a second app, so expect to find seams that are not yet generic: the web app and the SDK's types are written for the beauty advisor, and `scripts/build-spec.ts` builds the specification for it.

## Decisions

- **HTTP and JSON, with long-poll or SSE, rather than WebSocket.** It works through any proxy and from curl or any language. MCP is an adapter over the same runtime (`src/server/mcp.ts`, built on the official SDK), not a second implementation.
- **A tool's refusal is data; a malformed call is an error.** An LLM can read `ok: false` and recover. An HTTP `4xx` means the caller is wrong.
- **State in memory.** Photos never touch disk, and there is no database to secure or migrate. The price is one instance, or session-affine routing. `Runtime` is the only holder of session state, so a shared store would replace it there.
- **The client's token lives in the URL fragment**, which browsers do not send to servers, and the app removes it from the address bar once read.
- **The specification is generated from the code**, not written beside it, so it cannot drift. `tests/spec.test.ts` and `spec:check` fail when it does.

## Where this came from

The beauty advisor began as a skill inside a larger product for professionals and was rebuilt here as a standalone app. The protocol, runtime, server, SDK and UI shell are new. The beauty logic (tools, YouCam client, briefing, screens) is carried over and reworked.

Left behind in the move: server-side face cropping, so the face must now fill most of the photo; affiliate links, replaced by an optional link template; the host product's payments, rooms, devices, avatars and database; and an older content blocklist, replaced by a narrow floor.

## Limits

- Live YouCam calls are tested against a fake of its documented API, not against the live service.
- One instance, or session-affine routing. A restart ends every session.
- Only one app has been built on the runtime.
