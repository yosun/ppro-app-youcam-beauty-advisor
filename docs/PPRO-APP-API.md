# PPRO App API v1

How an external agent controls a Populi Professional app.

A **ppro-app** is the app a certified professional uses with a client: a screen the client sees, with tools behind it. This document defines one API that every ppro-app can implement, so an agent written once can run any of them. With it, an agent does everything the professional's own interface can do: it reads what the client says and shares, calls the app's tools, points the client at the part of the app it is talking about, and speaks.

Protocol identifier: `ppro-app/1`.
This repository is a complete implementation (the YouCam Beauty Advisor) and the reference for the rest of this document.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

- [1. The model](#1-the-model)
- [2. Roles and authentication](#2-roles-and-authentication)
- [3. Discovery: the manifest](#3-discovery-the-manifest)
- [4. Sessions](#4-sessions)
- [5. Events](#5-events)
- [6. Tools](#6-tools)
- [7. Controlling the app: screens and targets](#7-controlling-the-app-screens-and-targets)
- [8. Messages and speech](#8-messages-and-speech)
- [9. Photos, consent and privacy](#9-photos-consent-and-privacy)
- [10. Safety requirements](#10-safety-requirements)
- [11. Errors](#11-errors)
- [12. Embedding in a host page](#12-embedding-in-a-host-page)
- [13. MCP binding](#13-mcp-binding)
- [14. The YouCam Beauty Advisor](#14-the-youcam-beauty-advisor)
- [15. Conformance](#15-conformance)
- [16. Versioning](#16-versioning)

Machine-readable forms are generated from the code into [`spec/`](../spec): [`openapi.yaml`](../spec/openapi.yaml), JSON Schemas for the [manifest](../spec/schemas/manifest.schema.json), [session](../spec/schemas/session.schema.json), [events](../spec/schemas/event.schema.json) and [every tool's arguments](../spec/schemas/tools). If this prose and those files disagree, the files are right and this is a bug.

## 1. The model

```
   host (Populi Professional)                       client's browser
        │ creates a session                              │
        ▼                                                ▼
  ┌──────────────────────────  the ppro-app  ───────────────────────────┐
  │  session = identity + transcript + shared photos + app state        │
  │            + UI state (what the client sees) + budget + presence    │
  │                                                                     │
  │  every change is an EVENT with a rising rev                         │
  └─────────────────────────────────────────────────────────────────────┘
        ▲                      ▲
        │ tools, messages      │ events (long-poll or SSE)
        │                      │
      the agent  ──────────────┘   (any LLM, script or MCP client)
```

Four ideas carry the whole design.

1. **One source of truth.** The server holds the session. The client's app and the agent both read it and both change it through the API, never directly.
2. **Everything the client can do, the agent can see; everything the client sees, the agent can control.** The UI is a pure function of session state. The agent changes it with tools, the client changes it by using the app, and every change is an event both sides receive. (The exceptions are deliberate: the agent cannot take the client's photo or give the client's consent.)
3. **Tools are the agent's hands.** Each tool has a name, a description written for a model, and a JSON Schema. A tool that cannot do what was asked is a normal result (`ok: false`), not an HTTP error.
4. **The app enforces the rules, not the agent's good manners.** Consent, budgets, rate limits, text hygiene, sensitive-field removal and photo deletion are done by the app.

### Vocabulary

| Term        | Meaning                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **host**    | The party that offers the app to a client: a Populi Professional's backend, or a developer running the standalone demo. Creates sessions. |
| **agent**   | The advisor: an LLM, a script or any MCP client.                                                                                          |
| **client**  | The person being advised, in a browser.                                                                                                   |
| **session** | One consultation. In memory, time-boxed, deleted when it ends.                                                                            |
| **rev**     | A number that rises by one on every change to a session.                                                                                  |
| **target**  | A name for a screen or one item on it, such as `skin:pore` or `shade:1`.                                                                  |
| **units**   | The provider's currency (for YouCam: analysis credits). A session has a budget.                                                           |

## 2. Roles and authentication

Every request except discovery carries `Authorization: Bearer <token>`. A token MUST NOT be sent in a URL query string; the server ignores it there.

| Role     | Token                                                   | What it is for                                                                                               |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `host`   | A static key the operator configures (`PPRO_HOST_KEY`). | Create sessions, mint tokens, end sessions, relay the client's speech. Never given to a browser or an agent. |
| `agent`  | A signed session token.                                 | Call tools, post the advisor's messages, listen, read the briefing. Optionally read image bytes.             |
| `client` | A signed session token.                                 | Share photos, write messages, use the app, delete photos, end the session.                                   |

Session tokens (`p1.<payload>.<signature>`) are HMAC-signed, bound to one session and one role, and expire with the session plus a short retention window. A token for another session, or for a session that no longer exists, learns nothing: the server answers `404` where it could otherwise confirm the session exists.

The client's token reaches the browser in the **URL fragment** of the launch link (`/?s=<id>#t=<token>`). Fragments are not sent to servers or written to logs, and the app removes it from the address bar as soon as it is read.

`current` may stand for the session id in any path; it means the session the token belongs to.

### Who can do what

| Operation                                     |    host    |       agent       | client |
| --------------------------------------------- | :--------: | :---------------: | :----: |
| Create a session, mint tokens                 |     ✔      |                   |        |
| Read the session                              |     ✔      |         ✔         |   ✔    |
| End the session                               |     ✔      |         ✔         |   ✔    |
| Listen for events                             |     ✔      |         ✔         |   ✔    |
| Call tools, set presence                      |            |         ✔         |        |
| Read the advisor's briefing and the tool list |     ✔      |         ✔         |        |
| Post the advisor's message                    |            |         ✔         |        |
| Post the client's message                     | relay only |                   |   ✔    |
| Give consent, share photos, report UI events  |            |                   |   ✔    |
| Delete photos                                 |     ✔      |                   |   ✔    |
| Read image bytes                              |            | if `agent_vision` |   ✔    |
| Read the transcript text                      |     ✔      |                   |   ✔    |

Hosts never read image bytes. The advisor reads them only if the session was created with `agent_vision: true`.

## 3. Discovery: the manifest

`GET /.well-known/ppro-app.json` (also `GET /ppro/v1/manifest`). No authentication; CORS open. It is validated by [`spec/schemas/manifest.schema.json`](../spec/schemas/manifest.schema.json) and this app's own is [`spec/manifest.example.json`](../spec/manifest.example.json).

| Field                      | Meaning                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `protocol`                 | `ppro-app/1`. A client that does not know the value MUST NOT proceed.                                                          |
| `app`, `skill`, `provider` | Identity: id, name, version, the certification the app belongs to, the service behind it.                                      |
| `endpoints`                | Where the API, events, MCP and the web app are.                                                                                |
| `auth`                     | The roles and where a token goes.                                                                                              |
| `capabilities`             | `engine.mode` (`live`, `simulated` or `unavailable`), event transports, MCP, agent vision, spoken text, embedding, standalone. |
| `limits`                   | Sizes and rates the server enforces.                                                                                           |
| `screens`                  | The app's screens. The first is always available.                                                                              |
| `targets`                  | The target grammar: each section, the screen it lives on and what the item is.                                                 |
| `state`                    | JSON Schema of the session's `app` object.                                                                                     |
| `tools`                    | Every tool: name, description, group, cost, `needsPhoto`, `readOnly` and `inputSchema`.                                        |
| `events`                   | Every event type.                                                                                                              |
| `advisor`                  | The advisor's **guardrails** (normative, section 10), the disclaimer, starter prompts and where to fetch the briefing.         |
| `privacy`                  | Retention, sensitive attributes and consent, in words.                                                                         |

An agent SHOULD read the manifest once and adapt to it: use the `tools` it lists, show `advisor.disclaimer` where it speaks for the app, and respect `limits`.

## 4. Sessions

### Create (host)

`POST /ppro/v1/sessions`

```json
{
  "advisor": {
    "name": "Mara",
    "pronouns": "she/her",
    "persona": "Warm, a little witty. Short sentences."
  },
  "client": { "display_name": "Ada" },
  "minutes": 30,
  "agent_vision": false,
  "host_origin": "https://host.example",
  "units": 100,
  "consent": { "adult": true, "photo_analysis": true }
}
```

All fields are optional. `persona` is voice and personality notes for the advisor; it is shown to the host and agent only, never to the client. `host_origin` MUST be an origin the operator allowed (`PPRO_ALLOWED_ORIGINS`); it is where the embedded app sends its few messages (section 12). `consent` MAY be given only if the host itself collected those confirmations from the client; the session then records `consent.source: "host"`.

Response `201`:

```json
{
  "session": { "id": "ses_…", "rev": 1, "phase": "active", "…": "…" },
  "tokens": { "agent": "p1.…", "client": "p1.…" },
  "urls": {
    "client": "https://app.example/?s=ses_…#t=p1.…",
    "api": "https://app.example/ppro/v1",
    "events": "https://app.example/ppro/v1/sessions/ses_…/events",
    "mcp": "https://app.example/mcp"
  }
}
```

The host gives `tokens.agent` to the advisor's runtime and `urls.client` to the client's browser (or iframe). The agent token MUST NOT reach the browser.

### Read

`GET /ppro/v1/sessions/{id}` returns the **snapshot**. See [`session.schema.json`](../spec/schemas/session.schema.json). Besides identity, times and options, it holds:

| Field                      | Meaning                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `rev`                      | The revision this snapshot is at. Resume events from here.                                  |
| `phase`, `endReason`       | `active` or `ended`; why it ended (`client`, `agent`, `host`, `expired`).                   |
| `consent`                  | Whether the client confirmed they are an adult and agreed to analysis, and who attested it. |
| `budget`                   | Units total, used and remaining.                                                            |
| `engine.mode`              | `live`, `simulated` or `unavailable`.                                                       |
| `photos`                   | Metadata only. Image bytes are never in a snapshot.                                         |
| `messages`, `messageCount` | The latest messages (`?messages=N`, default 100, at most 300) and the transcript length.    |
| `app`                      | The app's own state, described by the manifest's `state` schema.                            |
| `ui`                       | What the client sees (below).                                                               |
| `presence`                 | `idle`, `thinking`, `speaking` or `listening`.                                              |

`ui`:

| Field              | Meaning                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `screen`, `target` | What the client is looking at now.                                                                     |
| `focus`            | Where the advisor last pointed, whether or not the client followed.                                    |
| `following`        | The app follows the advisor until the client takes over.                                               |
| `mediaRequest`     | A pending request for a photo, with the advisor's reason.                                              |
| `notice`, `nudge`  | A banner the advisor showed; a pointer ("new result on the Skin screen") that did not move the client. |
| `capturing`        | The client has the camera or picker open.                                                              |
| `available`        | Screens that have content.                                                                             |
| `view`             | App-defined view state (here, the before-and-after divider).                                           |

### End

`DELETE /ppro/v1/sessions/{id}` by the host, the agent or the client. The client's photos and every image made from them are deleted immediately. The transcript stays readable (`GET …/transcript.txt`, and the snapshot) for a few minutes, then the session is forgotten. A session also ends by itself when its time runs out (`endReason: "expired"`); `session.warning` events announce 5 and 1 minutes remaining on sessions long enough to need them.

After the end, every change (`POST` messages, tools, consent, UI events) answers `409 session_ended`.

### Mint a token (host)

`POST /ppro/v1/sessions/{id}/tokens` with `{"role": "client"}` or `{"role": "agent"}`. For a client token the response includes a fresh launch `url`.

## 5. Events

Every change to a session is an **event**:

```json
{
  "rev": 14,
  "at": 1793681499773,
  "type": "message.created",
  "actor": "client",
  "data": { "message": { "…": "…" } }
}
```

`rev` rises by exactly one per event, so a reader can tell it missed nothing. `actor` is `client`, `agent`, `host` or `app` (the server itself: timers, tool results).

| Type                                               | Meaning                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `session.started`                                  | Always rev 1.                                                                                     |
| `session.ended`                                    | The last event a session produces.                                                                |
| `session.warning`                                  | About 5 or 1 minutes remain.                                                                      |
| `consent.updated`                                  | The client confirmed or changed their consent.                                                    |
| `message.created`                                  | A transcript entry: the client's message or photo, the advisor's reply, or a tool result card.    |
| `photo.added` / `photo.rejected` / `photo.deleted` | The client shared, was refused (safe message included) or deleted a photo.                        |
| `tool.started` / `tool.completed`                  | A tool call began or finished (`ok`, `units`, `errorCode`).                                       |
| `app.updated`                                      | One top-level part of the app state changed: `data.kind` names it, `data.value` is its new value. |
| `ui.changed`                                       | What the client sees changed; `data.ui` is the whole UI state and `data.by` says who.             |
| `client.action`                                    | The client copied or saved something. Informational.                                              |
| `presence.changed`                                 | The advisor's presence changed.                                                                   |
| `budget.updated`                                   | Units were spent.                                                                                 |

Events carry whole values, so a reader keeps a current copy of the session by applying them to a snapshot and never has to refetch. The reference applier is [`src/web/apply-event.ts`](../src/web/apply-event.ts), and a test proves that applying every event to the first snapshot reproduces the server's final state exactly.

### Reading events

`GET /ppro/v1/sessions/{id}/events`

- **Long-poll (JSON).** `?after=<rev>&wait=<seconds, ≤25>[&types=a,b]`. Returns `{ "events": [...], "rev": N, "phase": "active" }` at once if events are waiting, otherwise after `wait` seconds with an empty list. **Resume from the response's `rev`**: the server chooses it in the same step as the events, so every matching event up to it is in the list and none after it was skipped. Works through any proxy.
- **Server-sent events.** Send `Accept: text/event-stream`. Each event is an SSE event named by its type, with `id` set to its rev, so a reconnecting client sends `Last-Event-ID`. A comment line (`: keepalive`) is sent every 15 seconds. The stream ends after `session.ended`.

The server keeps the latest 500 events per session. A cursor older than that answers `410 events_expired`; read the snapshot and continue from its `rev`.

Within one session tool calls run one at a time and events are produced in order, so rev order is the order things happened.

## 6. Tools

`POST /ppro/v1/sessions/{id}/tools/{name}`, agent only. The body is the tool's **arguments object** (an empty body means `{}`). Unknown properties are refused.

```json
{
  "ok": true,
  "tool": "analyze_skin",
  "callId": "cal_…",
  "units": 12,
  "result": { "…": "…" },
  "rev": 21,
  "unitsRemaining": 88
}
```

| Field                   | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `ok`                    | The tool did what was asked.                                                                 |
| `units`                 | Provider units charged. Only successful calls are charged.                                   |
| `result`                | A compact view for the agent. Every result lists the `target` of each item it returns.       |
| `error`                 | When `ok` is false: `{ code, message, retryable?, detail? }` (see [section 11](#11-errors)). |
| `rev`, `unitsRemaining` | The session after the call.                                                                  |

**Tool outcomes are data.** No photo yet, budget spent, the provider refusing the photo: these are `200` with `ok: false`, so an agent can read them like any other result. Only contract problems are HTTP errors: unknown tool (`404`), arguments that do not match the schema (`422 invalid_arguments`), too many calls (`429`), a session that ended (`409`).

**Idempotency.** Send `Idempotency-Key: <1-80 chars of A-Z a-z 0-9 _ . : ->` so a retry cannot be charged twice. The same key with the same arguments replays the first result (with `Idempotent-Replayed: true`, including when the first call is still running); the same key with different arguments is `409 idempotency_conflict`.

**Order and budget.** Calls within a session run one at a time, in arrival order. A call whose cost exceeds the remaining budget is refused before it runs (`budget_exhausted`).

### The catalog

Tools come in four groups. The envelope's own tools (the `session` group and the three UI tools) are the same in every ppro-app; the rest belong to the app.

| Tool                 | Group        | Cost  | Purpose                                                                                                                |
| -------------------- | ------------ | ----- | ---------------------------------------------------------------------------------------------------------------------- |
| `say`                | session      | free  | Send the client a chat message. Returns `spoken`, the words made safe to read aloud.                                   |
| `set_presence`       | session      | free  | Show `thinking`, `speaking`, `listening` or `idle`.                                                                    |
| `get_session_state`  | session      | free  | A compact read: time and budget left, consent, photos, what the client sees, what has been shown, the latest messages. |
| `wait_for_events`    | session      | free  | The long-poll as a tool, for agents that cannot make HTTP GETs (MCP).                                                  |
| `end_session`        | session      | free  | End the consultation.                                                                                                  |
| `ui_show`            | ui           | free  | Take the client to a screen or point at one item.                                                                      |
| `ui_request_photo`   | ui           | free  | Ask the client for a selfie.                                                                                           |
| `ui_notice`          | ui           | free  | Show a short banner.                                                                                                   |
| `ui_compare`         | ui           | free  | Move the before-and-after slider.                                                                                      |
| `analyze_skin`       | analysis     | 9–16  | Skin analysis: a 0–100 score per concern, with overlays.                                                               |
| `analyze_face`       | analysis     | 10–20 | Face shape and feature shapes.                                                                                         |
| `analyze_skin_tone`  | analysis     | 20    | Skin tone and eye, lip and brow colors as exact hex values.                                                            |
| `list_makeup_looks`  | analysis     | free  | Browse curated looks.                                                                                                  |
| `try_on_look`        | analysis     | 2     | Apply a curated look to the client's photo.                                                                            |
| `try_on_makeup`      | analysis     | 1     | Apply custom lip, blush or eyeshadow colors.                                                                           |
| `try_on_full_look`   | analysis     | 1     | A complete custom look: skin tint, contour, highlight, eyes, liner, lashes, blush, lips.                               |
| `recommend_products` | presentation | free  | Product cards on the Picks screen.                                                                                     |
| `present_look`       | presentation | free  | The look, its steps and its exact shades on the Look, Steps and Shades screens.                                        |

Each tool's description and arguments are in the manifest and in [`spec/schemas/tools/`](../spec/schemas/tools). `GET /ppro/v1/sessions/{id}/tools?format=native|openai|gemini|anthropic` returns them in the shape each framework expects.

## 7. Controlling the app: screens and targets

The app is a set of **screens**. A screen is _available_ when it has content (`ui.available`); `chat` always is. A **target** names a screen or one item on it:

```
target = section | section ":" item
```

The grammar (`[a-z][a-z0-9-]{1,23}` and an optional `[A-Za-z0-9_.-]{1,40}` item) belongs to the standard. The sections and what each item means belong to the app and are listed in the manifest:

| Section           | Screen | Item                                                    |
| ----------------- | ------ | ------------------------------------------------------- |
| `chat`            | chat   | none                                                    |
| `skin`            | skin   | the YouCam concern key, for example `skin:acne`         |
| `face`, `tone`    | face   | index into the face attributes, or the color attributes |
| `look`            | look   | none                                                    |
| `steps`, `step`   | steps  | none, or the index of one step                          |
| `shades`, `shade` | shades | none, or the index of one shade                         |
| `picks`, `pick`   | picks  | none, or the index of one product                       |

**An agent never builds a target by hand.** Every result lists the target of each item it returns (`"target": "skin:pore"`), and `get_session_state` lists every valid target. An unknown target is refused with the list of valid ones.

### Following

`ui_show` takes the client to a screen or target and sets `ui.following`. While following, the app shows what the advisor points at and highlights it (a step becomes the active one, the steps before it done). **The client can take over at any moment** by tapping anything; the app then stops following, and offers a _Follow_ button that returns to `ui.focus`. `ui_show` with `take_control: false` leaves a pointer without moving the client. New results leave a pointer too (a dot on the tab) without moving anyone; the pointer clears when the client arrives at that screen.

### What the client does, as events

| Client action                 | Server effect                         | Event                            |
| ----------------------------- | ------------------------------------- | -------------------------------- |
| Opens a tab                   | `ui.screen` changes, `following` ends | `ui.changed` (`by: client`)      |
| Taps an item                  | `ui.target` changes                   | `ui.changed`                     |
| Moves the slider              | `ui.view` changes                     | `ui.changed`                     |
| Opens or closes the camera    | `ui.capturing`                        | `ui.changed`                     |
| Dismisses a notice or request | cleared                               | `ui.changed`                     |
| Copies shades, saves an image | nothing                               | `client.action`                  |
| Shares a photo                | stored                                | `photo.added`, `message.created` |
| Writes a message              | transcript                            | `message.created`                |

Clipboard writes and downloads need a user gesture in a browser, so they are not tools; the agent sees them as `client.action`.

## 8. Messages and speech

A **message** has `seq`, `role` (`client`, `agent`, `tool`, `system`), `kind`, `body` and sometimes `data` and `spoken`. Kinds are `text` and `photo` for everyone, plus the kinds the app adds for its tool results (here `analysis`, `try_on`, `looks`, `picks`, `card`, `notice`). Tool entries carry the structured result in `data`, which is what the client's chat renders as cards.

`POST …/messages` with `{"text": "…"}`:

- An **agent** token posts the advisor's message. The server removes links and markdown, caps it at 1600 characters and refuses text that breaks the content rules (`422 content_blocked`; through the `say` tool this is `ok: false`). The message carries `spoken`: the same words with no links, markdown, emoji, bullets or numbering, a stop after each line, cut at a sentence to about 35 seconds of speech. **A voice agent speaks `spoken`, not `body`.**
- A **client** token posts the client's message (1000 characters).
- A **host** token relays what the client said (for example transcribed speech), and MUST set `"role": "client"`.

Bursts are limited (30 messages a minute per role) and answer `429` with `Retry-After`.

`GET /ppro/v1/sessions/{id}/instructions?style=chat|call` returns the advisor's **briefing**: the rules, the tools and how to use the screens, rendered for this session, including time and budget left, what the client has shared and what has already been shown. Use it as the core of the system prompt and fetch it again when the status matters. `style=call` asks for short spoken replies.

## 9. Photos, consent and privacy

- **Consent first.** Analysis needs two confirmations from the client: that they are 18 or older and that the photo is their own face, and that they agree to the provider analyzing it. Until both are given, photo uploads answer `409 consent_required` and photo tools answer `ok: false, consent_required`. The agent cannot give consent; it can only ask for a photo (`ui_request_photo`) and the app asks the client. A host may attest consent it collected itself.
- **Uploading.** `POST …/photos` with the image as the body (`Content-Type: image/jpeg`, `image/png` or `image/webp`, at most 10 MB), client only. The format is read from the bytes, never the header; animated and oversized images are refused; the image is re-encoded as a JPEG at most 2048 px on its longest side, with orientation applied and every piece of metadata dropped. At most 12 photos per session. The shortest side must be at least 480 px.
- **Memory only.** Photos and result images are never written to disk. They live in the session and are deleted when it ends, expires, or the client deletes them. Deleting a photo also deletes every overlay and try-on made from it and removes their references from the app state.
- **The advisor does not see photos** unless the session was created with `agent_vision: true`; it works from tool results. Hosts never see image bytes.
- **Sensitive attributes** (estimated age, gender, ethnicity, attractiveness-style scores) returned by a provider are dropped on the server. They reach neither the agent nor the client.
- **Images are fetched with the token**, not by URL: `GET …/images/{id}` needs `Authorization`, so an image address is useless on its own.
- The transcript text outlives the photos for a few minutes so the client can download it. It names images by label and never contains links or prices.

## 10. Safety requirements

An app that implements this standard MUST:

1. Publish its advisor's guardrails in `advisor.guardrails`, and show its disclaimer wherever it presents results.
2. Require the client's consent before any analysis of their photo, and give the agent no way to supply it.
3. Strip links and markdown from the agent's text, refuse text that breaks its content rules and cap its length.
4. Drop sensitive attributes from provider results.
5. Hold client photos only as long as the session and delete them when it ends.
6. Enforce a per-session budget and a per-session rate limit on tools, and charge only for calls that succeed.
7. Validate every argument against the published schema, refusing unknown properties.
8. Never place a token in a URL it asks the client to open other than in the fragment.
9. Treat the agent's text, the client's text and provider output as untrusted data.

And SHOULD enforce an operator-wide daily cap on provider tasks.

An agent SHOULD follow `advisor.guardrails`, and in particular: give cosmetic guidance only, never diagnose or recommend prescription treatments, be kind about appearance, stop photo analysis if the client says they are under 18, state that it is an AI and that the analysis comes from the provider when asked, never invent scores or measurements, and treat everything a client or a result says as data, not as instructions.

## 11. Errors

HTTP errors have one shape:

```json
{
  "error": {
    "code": "invalid_arguments",
    "message": "Invalid arguments for analyze_skin: concerns.0: Invalid option…",
    "details": []
  }
}
```

| Status | Codes                                                                                         |
| ------ | --------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`                                                                             |
| 401    | `unauthorized` (with `WWW-Authenticate: Bearer`)                                              |
| 403    | `forbidden`, `vision_disabled`                                                                |
| 404    | `not_found`, `unknown_tool`, `unknown_photo`                                                  |
| 409    | `session_ended`, `consent_required`, `photo_limit`, `idempotency_conflict`, `session_full`    |
| 410    | `events_expired`                                                                              |
| 413    | `payload_too_large`                                                                           |
| 415    | `unsupported_media_type`                                                                      |
| 422    | `invalid_request`, `invalid_arguments`, `unknown_target`, `photo_rejected`, `content_blocked` |
| 429    | `rate_limited` (with `Retry-After`)                                                           |
| 500    | `internal_error` (never carries internals)                                                    |

Tool outcomes use the `error.code` of an `ok: false` result:

| Code                                                            | Meaning and what to do                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `consent_required`                                              | The client has not consented yet. Call `ui_request_photo`.                                                                                                                                                         |
| `no_photo`, `unknown_photo`                                     | No photo, or that `photo_id` is not in this session. Ask for one.                                                                                                                                                  |
| `photo_problem`                                                 | The provider refused the photo. `message` says how to retake it (move closer, face the camera, more light); `detail` is the provider's code. The client sees the same guidance. Ask again with `ui_request_photo`. |
| `budget_exhausted`                                              | The session cannot afford the call. Carry on with what you have.                                                                                                                                                   |
| `daily_limit`                                                   | The operator's daily cap is reached.                                                                                                                                                                               |
| `unavailable`                                                   | The provider is switched off. Give general advice and say so.                                                                                                                                                      |
| `no_results`, `save_failed`, `tool_error`                       | The provider returned nothing usable, or something failed. Usually `retryable`.                                                                                                                                    |
| `unknown_look`, `unknown_image`, `unknown_target`, `no_effects` | The arguments name something that does not exist.                                                                                                                                                                  |
| `nothing_to_show`                                               | The screen the call needs has no content yet.                                                                                                                                                                      |
| `content_blocked`, `invalid_arguments`                          | The text was refused, or is empty once cleaned.                                                                                                                                                                    |
| `session_ended`                                                 | The session ended during the call.                                                                                                                                                                                 |

## 12. Embedding in a host page

A host shows the client's app in an iframe pointing at `urls.client`, with `allow="camera"` if it wants the live camera. The operator lists the host's origin in `PPRO_ALLOWED_ORIGINS`; the app then allows framing by exactly those origins (`frame-ancestors`) and never by `*`. Create the session with `host_origin` set to the embedding page's origin.

The app and the host exchange a few `postMessage` messages and nothing else. The app posts only to `host_origin` (never `"*"`) and listens only to `window.parent` at that origin.

| Direction  | `type`   | `data`                                            |
| ---------- | -------- | ------------------------------------------------- |
| app → host | `ready`  | `{ sessionId, rev }`                              |
| app → host | `screen` | `{ screen, target }`: the client's screen changed |
| app → host | `ended`  | `{ reason }`                                      |
| host → app | `theme`  | `{ accent: "#RRGGBB" }`                           |

Messages are `{ "source": "ppro-app" | "ppro-host", "v": 1, "type", "data" }`. **Chat messages, photos, results and notices never travel this way.** They are private to the client, and a host that needs them reads them from the API with its own credentials. See [HOST-GUIDE.md](HOST-GUIDE.md).

## 13. MCP binding

`POST /mcp` (Streamable HTTP) exposes the same tools to any MCP client. It serves the 2026-07-28 revision (stateless: no `initialize`, each request names its version) and the 2025 revisions from one endpoint.

- Authenticate with the **advisor's session token** as a bearer token. The token also selects the session, so tools take no `session` argument.
- `tools/list` returns the same 18 tools with the same JSON Schemas. `readOnlyHint` is set on the read-only ones.
- A tool result is the `ToolResponse` as JSON text and as `structuredContent`; `isError` is true when `ok` is false.
- The `advisor_instructions` prompt returns the briefing.
- Because MCP has no server push, an MCP agent listens with the `wait_for_events` tool.

## 14. The YouCam Beauty Advisor

This repository's app. Provider: YouCam AI by Perfect Corp (your own API key; without one the app runs in **simulated mode**, with deterministic results labeled as demo previews and no YouCam calls). Not affiliated with or endorsed by Perfect Corp.

Screens: **Chat** (the conversation, tool results as cards, photo capture), **Skin** (a score per concern, what needs the most care first, with overlays), **Face** (face shape and features, and skin tone and colors as swatches), **Look** (the presented look as a before-and-after), **Steps**, **Shades** (exact hex codes, copy buttons, copy-all and save) and **Picks** (specific products).

Units follow YouCam's published cost table: skin analysis 9–16 by concerns requested, face attributes 10–20, skin tone 20, curated look 2, makeup 1. A session defaults to 100 units (`YOUCAM_UNITS_PER_SESSION`) and the server to 300 tasks a day (`YOUCAM_DAILY_TASK_CAP`).

Behaviours worth knowing:

- Contour and highlight in `try_on_full_look` are placed using the client's measured **skin color and face shape** from earlier analyses in the same session, unless the call passes its own.
- A skin tint in a full look always uses the measured skin color when there is one, so a try-on never lightens or darkens anyone's skin.
- Photos are sent to YouCam at most 1024 px on the longest side (its makeup try-on rejects larger sources) and uploaded once per session, then reused.
- YouCam scores skin only when the face spans more than 60% of the photo's width. A selfie that does not is refused with a `photo_problem` that says to move closer; the live camera enforces the framing.
- Product picks contain no prices and no links. A link appears only if the operator configures `PPRO_PRODUCT_LINK_TEMPLATE` (an `https` URL containing `{query}`).

## 15. Conformance

An implementation conforms to `ppro-app/1` if all of these hold. Each can be checked from outside with the files in `spec/`.

**Discovery**

- [ ] `GET /.well-known/ppro-app.json` validates against `manifest.schema.json`.
- [ ] `protocol` is `ppro-app/1`; the first screen is always available.

**Sessions and auth**

- [ ] Creating a session needs the host key; an agent or client token is `403`.
- [ ] A token never works on another session, and the server answers `404`, not `403`, for one that does not exist.
- [ ] A token in a query string is ignored.
- [ ] The persona is absent from the client's snapshot.
- [ ] After `DELETE`, photos and result images are gone and changes answer `409 session_ended`.

**Events**

- [ ] `rev` rises by exactly one per event and `session.started` is rev 1.
- [ ] A long-poll response's `rev` is chosen with its events (no event can fall between).
- [ ] Applying all events to the first snapshot reproduces the final state.
- [ ] A too-old cursor is `410 events_expired`.

**Tools**

- [ ] Every tool in the manifest validates its arguments against its `inputSchema` and refuses unknown properties.
- [ ] A refusal is `200` with `ok: false`; a contract error is an HTTP error.
- [ ] Only successful calls are charged; an over-budget call is refused before it runs.
- [ ] A repeated `Idempotency-Key` replays rather than re-running.

**Safety**

- [ ] Section 10 items 1 to 9.
- [ ] Consent is required for photo upload and photo tools, and the agent cannot supply it.
- [ ] An agent cannot read image bytes unless the session allows it, and hosts never can.

The reference implementation runs all of these as its test suite (`npm test`, 150+ tests) and a browser suite (`npm run test:e2e`) in which an agent using only the SDK drives a real browser through every screen.

## 16. Versioning

`ppro-app/1` changes only in compatible ways: new optional fields, new event types, new tools, new error codes. A client MUST ignore fields and event types it does not know. A change that breaks a client increases the number in `protocol` and the API prefix (`/ppro/v2`), and an app MAY serve both. A new app tool is not a protocol change; it appears in the manifest.
