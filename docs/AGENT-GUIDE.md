# Agent guide

How to be the beauty advisor. If you have an agent (an LLM with tools, a script, an MCP client), this takes you from nothing to a running consultation. The full rules are in [PPRO-APP-API.md](PPRO-APP-API.md).

## Try it in two minutes

```sh
npm install
npm run dev                  # the app on http://localhost:5173 (API on :8787)
```

Open the app and press **Start a demo consultation**. You are the client in the phone; the panel beside it shows how to connect an advisor, with your session's token. With no YouCam key the app is in simulated mode: results are deterministic and labeled _Demo preview_, and nothing is billed.

Run the scripted advisor (no LLM needed) from the panel's command:

```sh
PPRO_URL=http://localhost:8787 PPRO_AGENT_TOKEN=<token from the panel> npm run agent:demo
```

It greets you, asks for a selfie, and when you share one it analyzes your skin, face and colors, tries a look on you and walks you through it.

## The loop

Every advisor, whatever it is built on, does the same four things.

```
1. read    GET  /ppro/v1/sessions/current/instructions     your briefing (the rules, the tools, the status)
2. listen  GET  /ppro/v1/sessions/current/events?after=N&wait=20
3. act     POST /ppro/v1/sessions/current/tools/{name}     analyze, try on, show, point
4. speak   POST /ppro/v1/sessions/current/messages         your reply
```

With the TypeScript SDK ([`src/client`](../src/client/index.ts)) that is:

```ts
import { AdvisorClient } from "./src/client/index.ts";

const advisor = new AdvisorClient({ baseUrl, token: agentToken });
const manifest = await advisor.manifest(); // what the app is and can do
const briefing = await advisor.instructions(); // your system prompt
const tools = await advisor.tools("openai"); // or "gemini", "anthropic", "native"

for await (const event of advisor.events()) {
  // resumes after drops, ends with the session
  if (
    event.type === "message.created" &&
    event.data.message.role === "client"
  ) {
    await advisor.presence("thinking");
    // ...let your model decide; run its tool calls with advisor.tool(name, args)...
    await advisor.say(reply); // clean text; returns `spoken` for voice
  }
  if (event.type === "photo.added") {
    /* the client shared a selfie: analyze it */
  }
}
```

[`examples/scripted-agent.ts`](../examples/scripted-agent.ts) is a complete working advisor in about 200 lines, and the best thing to read after this page.

## Using an LLM

1. **System prompt**: fetch `GET …/instructions` (`?style=call` if the reply will be spoken). It is written for the model and already holds the safety rules, the tool usage, the client's name and the live status. Fetch it again when the status matters (time left, budget left, what has been shown).
2. **Tools**: fetch `GET …/tools?format=openai|gemini|anthropic` and pass the result straight to your framework. The names, descriptions and schemas are the contract.
3. **Run the model's tool calls** with `POST …/tools/{name}` and give it the response back as the tool result. A refusal comes back as `ok: false` with an `error.code` and a message the model can act on (`no_photo`, `photo_problem`, `budget_exhausted`…), so there is no special handling. Only arguments that do not match the schema are an HTTP error (`422`), and the message says which argument.
4. **Reply** with `POST …/messages` (or the `say` tool). Plain text; links and markdown are removed for you.

A short, runnable LLM loop that follows exactly this is in [`examples/llm-agent.ts`](../examples/llm-agent.ts).

## Over MCP

If your agent runs in an MCP client (Claude Code, Cursor, any), point it at the app and give it the advisor's token. Nothing else is needed:

```sh
claude mcp add --transport http beauty-advisor http://localhost:8787/mcp \
  --header "Authorization: Bearer <advisor token>"
```

You get the same 18 tools and an `advisor_instructions` prompt. MCP has no push, so listen with the `wait_for_events` tool (pass the `rev` you last saw as `after_rev`; it returns at once if something is waiting and otherwise after up to 25 seconds).

## Running the whole app

Everything the client sees, you can control. Think like a presenter.

| You want to…                            | Call                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Ask for a selfie                        | `ui_request_photo` (the app collects consent and offers the live camera)                       |
| Measure the skin                        | `analyze_skin`, then `ui_show {target: "skin:pore"}` while you explain pores                   |
| Read face shape and colors              | `analyze_face`, `analyze_skin_tone`                                                            |
| Show the client a look on themselves    | `list_makeup_looks` + `try_on_look`, or `try_on_makeup`, or `try_on_full_look`                 |
| Put the result where they can keep it   | `present_look` (title, steps, exact shades, the try-on image), then `ui_show {target: "look"}` |
| Reveal the before-and-after as you talk | `ui_compare {reveal: 100}`                                                                     |
| Walk through the steps                  | `ui_show {target: "step:0"}`, then `step:1`, … (the earlier steps tick off)                    |
| Recommend products                      | `recommend_products`                                                                           |
| Say something short on screen           | `ui_notice`                                                                                    |
| End                                     | `say` goodbye, then `end_session`                                                              |

You never build a target yourself: every result tells you the `target` of each item it returned, and `get_session_state` lists every valid one.

### What you see happen

Listen for these and react:

- `photo.added`: the client shared a selfie. Analyze it.
- `message.created` with `role: "client"`: they said something.
- `ui.changed` with `by: "client"`: they moved. If `data.ui.following` is false they took the screen; you can still point (`ui_show` with `take_control: false`) or wait.
- `client.action`: they copied a shade or saved the look.
- `photo.rejected`: a photo was refused; the message is safe to relay.
- `session.warning`: 5 or 1 minutes left. Wrap up.
- `session.ended`: stop.

## Things that will bite you

- **Start listening before you do anything else.** `advisor.events()` takes its starting point when you call it. If you fetch the tools or the briefing first and _then_ start listening, whatever the client did in between (their first message, a photo) happened before your cursor and you will never see it. Call `events()` first, then fetch the rest. With raw HTTP: read the session once, keep its `rev`, and pass it as `after`.
- **A selfie that fills too little of the frame** is refused by YouCam (`photo_problem`, "Move closer…"). The client sees the same guidance. Ask for a retake with `ui_request_photo`.
- **Consent is not yours to give.** Before the client has agreed, photo tools answer `consent_required`. Ask for a selfie; the app asks them.
- **Budget.** A session has 100 units by default. Skin analysis costs 9 to 16 (12 for the default eight concerns), face analysis 10 to 20 (10 for the default five features), skin tone 20, a curated look 2 and any other try-on 1. Plan the order; `get_session_state` shows what is left.
- **Do not repeat an analysis** that already has results unless the photo changed.
- **Retries are safe only with an `Idempotency-Key`.** A timeout on a paid tool is ambiguous; the same key replays instead of paying twice.
- **Voice agents speak `spoken`**, not `body`. It has no links, markdown, bullets or emoji and ends on a sentence.
- **You cannot see the photo** unless the session allows it (`agent_vision`). Describe only what the tools returned.

## Calling the API without the SDK

```sh
T=<advisor token>; B=http://localhost:8787/ppro/v1/sessions/current
curl -s $B -H "Authorization: Bearer $T"                                              # snapshot
curl -s "$B/events?after=0&wait=20" -H "Authorization: Bearer $T"                     # listen
curl -s -X POST $B/tools/analyze_skin -H "Authorization: Bearer $T" \
     -H "Idempotency-Key: skin-1" -H "Content-Type: application/json" -d '{}'        # act
curl -s -X POST $B/messages -H "Authorization: Bearer $T" \
     -H "Content-Type: application/json" -d '{"text":"Here is what I see."}'          # speak
```
