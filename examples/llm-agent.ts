// An advisor driven by an LLM, in one file and about 100 lines. It is the loop
// from docs/AGENT-GUIDE.md and nothing else:
//
//   briefing -> listen -> let the model decide -> run its tool calls -> reply
//
// The model is behind a two-method interface, so the loop works with any
// provider. `geminiModel` below is one implementation (Google's Gemini through
// its REST API; set GEMINI_API_KEY). Write another for OpenAI, Anthropic or a
// local model by returning the same shape; the tool declarations are available
// in each of their formats from `advisor.tools("openai" | "anthropic")`.
//
//   GEMINI_API_KEY=... PPRO_URL=http://localhost:8787 PPRO_AGENT_TOKEN=... \
//     npx tsx examples/llm-agent.ts

import { pathToFileURL } from "node:url";
import {
  AdvisorClient,
  PproError,
  type BeautyAdvisorClient,
} from "../src/client/index.ts";

/** One turn of a conversation with a model. */
export type Turn =
  | { role: "user"; text: string }
  | {
      role: "model";
      text?: string;
      calls?: { name: string; args: Record<string, unknown> }[];
    }
  | { role: "tool"; results: { name: string; result: unknown }[] };

export type ModelReply = {
  text?: string;
  calls?: { name: string; args: Record<string, unknown> }[];
};

export interface Model {
  /** One model step: the briefing, the conversation so far, and the tools. */
  step(input: {
    system: string;
    turns: Turn[];
    tools: unknown[];
  }): Promise<ModelReply>;
  /** The tool declarations in the format this model wants. */
  toolFormat: "gemini" | "openai" | "anthropic";
}

const MAX_STEPS = 6; // tool rounds per client message

export async function runLlmAdvisor(
  advisor: BeautyAdvisorClient,
  model: Model,
  options: { log?: (line: string) => void; signal?: AbortSignal } = {},
) {
  const log = options.log ?? (() => undefined);
  // Start listening before anything else: whatever the client does while the
  // tools are fetched must still reach the loop.
  const events = advisor.events({ signal: options.signal });
  const tools = await advisor.tools(model.toolFormat);
  const turns: Turn[] = [];

  for await (const event of events) {
    // What the model should react to, as one line of context.
    let prompt: string | null = null;
    if (
      event.type === "message.created" &&
      event.data.message.role === "client"
    ) {
      prompt =
        event.data.message.kind === "photo"
          ? null // the photo.added event below says it better
          : `The client says: ${event.data.message.body}`;
    } else if (event.type === "photo.added") {
      prompt =
        "The client just shared a selfie. Analyze it and talk them through what you find.";
    } else if (event.type === "session.warning") {
      prompt = `About ${event.data.minutesLeft} minute(s) remain. Wrap up.`;
    }
    if (!prompt) continue;

    turns.push({ role: "user", text: prompt });
    await advisor.presence("thinking");
    // The briefing is fetched fresh each turn so time and budget are current.
    const system = await advisor.instructions();

    for (let round = 0; round < MAX_STEPS; round++) {
      const reply = await model.step({ system, turns, tools });
      turns.push({ role: "model", text: reply.text, calls: reply.calls });
      if (!reply.calls?.length) {
        if (reply.text?.trim()) {
          log(`advisor: ${reply.text}`);
          await advisor.say(reply.text);
        }
        break;
      }
      const results: { name: string; result: unknown }[] = [];
      for (const call of reply.calls) {
        log(`tool: ${call.name} ${JSON.stringify(call.args)}`);
        try {
          // A refusal comes back as ok:false data the model can act on.
          const response = await advisor.tool(call.name, call.args);
          results.push({ name: call.name, result: response });
        } catch (error) {
          // A bad argument is an HTTP error; give the model the message.
          if (!(error instanceof PproError)) throw error;
          results.push({
            name: call.name,
            result: {
              ok: false,
              error: { code: error.code, message: error.message },
            },
          });
        }
      }
      turns.push({ role: "tool", results });
    }
    await advisor.presence("idle");
    // Keep the context bounded: the briefing and tools carry the rest.
    if (turns.length > 40) turns.splice(0, turns.length - 40);
  }
}

// --- One model: Gemini over REST ---------------------------------------------------

export function geminiModel(
  apiKey: string,
  name = process.env.GEMINI_MODEL || "gemini-2.5-flash",
): Model {
  return {
    toolFormat: "gemini",
    async step({ system, turns, tools }) {
      const contents = turns.map((turn) =>
        turn.role === "user"
          ? { role: "user", parts: [{ text: turn.text }] }
          : turn.role === "model"
            ? {
                role: "model",
                parts: [
                  ...(turn.text ? [{ text: turn.text }] : []),
                  ...(turn.calls ?? []).map((call) => ({
                    functionCall: { name: call.name, args: call.args },
                  })),
                ],
              }
            : {
                role: "user",
                parts: turn.results.map((r) => ({
                  functionResponse: {
                    name: r.name,
                    response: { result: r.result },
                  },
                })),
              },
      );
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${name}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents,
            tools,
            generationConfig: { temperature: 0.6, maxOutputTokens: 1024 },
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!response.ok) throw new Error(`Gemini answered ${response.status}`);
      const body = (await response.json()) as {
        candidates?: {
          content?: {
            parts?: {
              text?: string;
              functionCall?: { name: string; args?: Record<string, unknown> };
            }[];
          };
        }[];
      };
      const parts = body.candidates?.[0]?.content?.parts ?? [];
      return {
        text:
          parts
            .map((part) => part.text ?? "")
            .join("")
            .trim() || undefined,
        calls: parts
          .filter((part) => part.functionCall)
          .map((part) => ({
            name: part.functionCall!.name,
            args: part.functionCall!.args ?? {},
          })),
      };
    },
  };
}

async function main() {
  const key = process.env.GEMINI_API_KEY;
  const token = process.env.PPRO_AGENT_TOKEN;
  if (!key || !token) {
    console.error(
      "Set GEMINI_API_KEY and PPRO_AGENT_TOKEN (and PPRO_URL if not localhost:8787).",
    );
    process.exit(1);
  }
  const advisor = new AdvisorClient({
    baseUrl: (process.env.PPRO_URL ?? "http://localhost:8787").replace(
      /\/+$/,
      "",
    ),
    token,
  }) as BeautyAdvisorClient;
  console.log("LLM advisor running. Ctrl-C to stop.");
  await runLlmAdvisor(advisor, geminiModel(key), {
    log: (line) => console.log(line),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
