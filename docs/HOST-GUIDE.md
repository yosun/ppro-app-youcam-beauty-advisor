# Host guide

How a Populi Professional (or any product) offers this app to a client and puts an agent in charge of it. A **host** is the party that has the client: it creates the session, shows the client's side in the browser and gives the advisor's side to the agent. The full rules are in [PPRO-APP-API.md](PPRO-APP-API.md).

```
 your backend ──(host key)──► POST /ppro/v1/sessions ──► { tokens.agent, tokens.client, urls.client }
      │                                                         │                │
      │ gives tokens.agent to                                   │                │ urls.client
      ▼                                                         ▼                ▼
 the advisor's runtime  ◄────────── API / MCP ──────────►  this app  ◄────  the client's browser / iframe
 (LLM, voice, avatar)                                     (one deployment, many sessions)
```

## What you run

One deployment of this app serves any number of sessions at once. Deploy it anywhere that runs Node 22+ (`npm run build && npm start`), or use `Dockerfile`. Configure it with environment variables ([`.env.example`](../.env.example)). With `NODE_ENV=production` the server refuses to start without a signing secret and a public URL, and without a host key unless `PPRO_STANDALONE=true` (which lets the bundled web app start its own demo sessions, so no host is needed).

| Variable               | Needed             | Purpose                                                                      |
| ---------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `PPRO_SIGNING_SECRET`  | always             | 32+ random characters. Signs session tokens. Rotating it ends every session. |
| `PPRO_PUBLIC_URL`      | always             | The deployment's public origin, used in launch links and the manifest.       |
| `PPRO_HOST_KEY`        | to create sessions | 24+ characters. The key your backend uses to create sessions.                |
| `PPRO_ALLOWED_ORIGINS` | to embed the app   | Exact origins allowed to embed the app (comma-separated, never `*`).         |
| `YOUCAM_API_KEY`       | for real results   | Your YouCam API key. Without it the app runs in simulated mode.              |

Keep all of these in a secret manager, not in the repository. `PPRO_HOST_KEY` and the agent tokens never go to a browser.

Sessions are held in memory in one process: photos never touch disk, and restarting the server ends every session. Run one instance, or put session-affine routing in front of several (a session's requests must reach the instance that created it). A shared store is a natural extension; the `Runtime` keeps all session state behind one class for that reason.

## Starting a consultation

From your backend, when the client is ready (for example after they paid and the booking opened):

```ts
import { HostClient } from "./src/client/index.ts";

const host = new HostClient({
  baseUrl: "https://beauty.example.com",
  hostKey: process.env.PPRO_HOST_KEY!,
});
const created = await host.createSession({
  advisor: {
    name: "Mara",
    pronouns: "she/her",
    persona: "Warm, a little witty. Short sentences.",
  },
  client: { display_name: "Ada" },
  minutes: 30, // however long they paid for
  host_origin: "https://populi.example", // the page that will embed the app
  consent: { adult: true, photo_analysis: true }, // ONLY if you collected these yourself
});
```

Then two hand-offs:

1. **To the client's browser**: `created.urls.client`. The client token is in the URL fragment, so it is never sent to a server. Put it in an iframe (below) or open it in a new tab.
2. **To the advisor**: `created.tokens.agent`, to whatever runs the advisor. Keep it on your servers.

`persona` is how you give the advisor its voice (a Populi character's personality, say). It reaches the advisor's briefing but is never shown to the client, and the safety rules in the briefing cannot be overridden by it.

If the client loses their link, mint a new one: `host.mintToken(created.session.id, "client")` returns a fresh `url`.

## Embedding the client's side

```html
<iframe
  src="https://beauty.example.com/?s=ses_…#t=p1.…"
  allow="camera"
  style="border:0; width:100%; height:100%"
  title="Beauty consultation"
></iframe>
```

- `allow="camera"` lets the client use YouCam's live camera. Without it the client uploads a photo instead.
- The operator must list your page's origin in `PPRO_ALLOWED_ORIGINS`. The app then allows framing by exactly those origins and by no others.
- Pass the same origin as `host_origin` when you create the session. The app posts its few messages only to that origin and listens only to its parent window at that origin.

### The few messages

Everything the app tells the page around it:

```js
window.addEventListener("message", (event) => {
  if (event.origin !== "https://beauty.example.com") return; // the app's origin
  if (event.source !== iframe.contentWindow) return;
  const m = event.data;
  if (m?.source !== "ppro-app" || m.v !== 1) return;
  if (m.type === "ready") {
    /* { sessionId, rev } */
  }
  if (m.type === "screen") {
    /* { screen, target }: the client moved */
  }
  if (m.type === "ended") {
    /* { reason } */
  }
});

// Restyle the accent color:
iframe.contentWindow.postMessage(
  { source: "ppro-host", v: 1, type: "theme", data: { accent: "#9257ec" } },
  "https://beauty.example.com",
);
```

That is all. **The client's messages, photos, results and notices are not sent to the page.** If your product needs the conversation (a transcript for the client's account, say), read it from the API with your host key: `GET /ppro/v1/sessions/{id}` (a host can read the snapshot) and `GET …/transcript.txt`. A host cannot read image bytes.

## Relaying the client's voice

If the client talks to the advisor (a live avatar, a phone call), you transcribe their speech and put it in the conversation as the client's words:

```ts
await fetch(`${base}/ppro/v1/sessions/${id}/messages`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${hostKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ role: "client", text: transcript }),
});
```

and speak the advisor's replies from the `spoken` field of each `message.created` event whose `message.role` is `agent`. `spoken` has no links, markdown, bullets or emoji and ends on a sentence, so it is safe to hand to a text-to-speech or avatar service as it is. Set `set_presence` to `speaking` while the voice plays, so the client's app shows it.

## Ending

`DELETE /ppro/v1/sessions/{id}` with the host key ends the consultation at any time (the client's time ran out, they asked to stop, a payment was reversed). The client's photos and everything made from them are deleted at once. A session also ends by itself when `minutes` run out; `session.warning` events say when 5 and 1 minutes remain.

## Checklist before going live

- [ ] `NODE_ENV=production`, with the variables above that apply to you, from a secret manager.
- [ ] `PPRO_ALLOWED_ORIGINS` lists only your pages.
- [ ] The advisor's token never reaches a browser; the host key never leaves your backend.
- [ ] You collect your own 18+ and photo-analysis consent _or_ you leave `consent` out and let the app ask.
- [ ] You show the client the app's disclaimer ("for reference only, not medical advice") if you render results yourself.
- [ ] You tell the client the advisor is an AI.
- [ ] You have read the YouCam API terms for your key, and your own privacy policy covers photo analysis by a third party.
- [ ] `YOUCAM_UNITS_PER_SESSION` and `YOUCAM_DAILY_TASK_CAP` match what you are willing to spend.
