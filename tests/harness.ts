import "./helpers.ts";
import { beautyAdvisor } from "../src/advisor/app.ts";
import { createApp } from "../src/server/app.ts";
import { loadConfig, type Config } from "../src/server/config.ts";
import { Runtime } from "../src/server/runtime.ts";
import type { BeautyState, BeautyView } from "../src/advisor/types.ts";
import type {
  PproEvent,
  Session,
  ToolResponse,
} from "../src/protocol/types.ts";
import { makePhoto } from "./helpers.ts";

// An in-process server: requests go straight to the Hono app, no sockets.

export const HOST_KEY = "host_key_for_tests_0123456789abcdef";
export const SECRET = "s".repeat(48);
export const ORIGIN = "https://host.example";

export type Clock = { t: number };

export type Req = {
  token?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  type?: string;
};

export function testServer(
  overrides: Partial<Config> = {},
  clock: Clock = { t: Date.now() },
) {
  const config = loadConfig(
    {
      PPRO_SIGNING_SECRET: SECRET,
      PPRO_HOST_KEY: HOST_KEY,
    } as NodeJS.ProcessEnv,
    {
      production: false,
      standalone: true,
      mcp: true,
      allowedOrigins: [ORIGIN],
      publicUrl: "http://app.test",
      ...overrides,
    },
  );
  const runtime = new Runtime<BeautyState, BeautyView>(beautyAdvisor, config, {
    now: () => clock.t,
  });
  const app = createApp(runtime, config);

  async function call(method: string, path: string, req: Req = {}) {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (req.token) headers.Authorization = `Bearer ${req.token}`;
    let body: BodyInit | undefined = req.body;
    if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.type) headers["Content-Type"] = req.type;
    return app.request(path, { method, headers, body });
  }

  async function data<T = Record<string, unknown>>(
    method: string,
    path: string,
    req: Req = {},
    expect = 200,
  ): Promise<T> {
    const response = await call(method, path, req);
    const text = await response.text();
    if (response.status !== expect)
      throw new Error(
        `${method} ${path} -> ${response.status} (wanted ${expect}): ${text.slice(0, 300)}`,
      );
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function newSession(body: Record<string, unknown> = {}) {
    const created = await data<{
      session: Session<BeautyState, BeautyView>;
      tokens: { agent: string; client: string };
      urls: { client: string; api: string; events: string; mcp: string | null };
    }>("POST", "/ppro/v1/sessions", { token: HOST_KEY, json: body }, 201);
    const id = created.session.id;
    const { agent, client } = created.tokens;
    const base = `/ppro/v1/sessions/${id}`;
    const session = {
      id,
      agent,
      client,
      created,
      base,
      state: (token = agent) =>
        data<Session<BeautyState, BeautyView>>("GET", base, { token }),
      tool: (
        name: string,
        args: unknown = {},
        headers: Record<string, string> = {},
      ) =>
        data<ToolResponse>("POST", `${base}/tools/${name}`, {
          token: agent,
          json: args,
          headers,
        }),
      say: (text: string) =>
        data("POST", `${base}/messages`, { token: agent, json: { text } }, 201),
      chat: (text: string) =>
        data(
          "POST",
          `${base}/messages`,
          { token: client, json: { text } },
          201,
        ),
      consent: () =>
        data("POST", `${base}/consent`, {
          token: client,
          json: { adult: true, photo_analysis: true },
        }),
      photo: async (width = 720, height = 960) =>
        data<{ photo: { id: string; width: number; height: number } }>(
          "POST",
          `${base}/photos`,
          {
            token: client,
            body: new Uint8Array(await makePhoto(width, height)),
            type: "image/jpeg",
          },
          201,
        ),
      events: (after = 0, wait = 0) =>
        data<{ events: PproEvent[]; rev: number; phase: string }>(
          "GET",
          `${base}/events?after=${after}&wait=${wait}`,
          { token: agent },
        ),
    };
    return session;
  }

  /** A session whose client consented and shared a photo. */
  async function readySession(body: Record<string, unknown> = {}) {
    const session = await newSession(body);
    await session.consent();
    const { photo } = await session.photo();
    return { ...session, photoId: photo.id };
  }

  return { app, runtime, config, clock, call, data, newSession, readySession };
}

export type TestServer = ReturnType<typeof testServer>;

/** Reads server-sent events from a response until `stop` returns true. */
export async function readSse(
  response: Response,
  stop: (events: PproEvent[]) => boolean,
  timeoutMs = 3000,
): Promise<PproEvent[]> {
  const events: PproEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && !stop(events)) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(
            () => resolve({ done: true, value: undefined }),
            Math.max(1, deadline - Date.now()),
          ),
        ),
      ]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (data) events.push(JSON.parse(data) as PproEvent);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}
