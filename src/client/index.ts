// A small typed client for PPRO App API v1. It runs in Node and in the browser
// (it needs only `fetch`) and is the only code an agent author has to import.
//
//   const advisor = new AdvisorClient({ baseUrl, token: agentToken });
//   for await (const event of advisor.events()) { ... }
//   await advisor.tool("analyze_skin");
//   await advisor.say("Here is what I see.");

import { API_PREFIX } from "../protocol/constants.ts";
import type { ToolFormat } from "../protocol/formats.ts";
import type { Manifest } from "../protocol/manifest.ts";
import type {
  Presence,
  PproEvent,
  Session,
  ToolResponse,
} from "../protocol/types.ts";

import type { BeautyState, BeautyView } from "../advisor/types.ts";

export type ClientOptions = {
  /** The server's origin, for example https://beauty.example.com. */
  baseUrl: string;
  /** A session token (agent or client) or, for hosts, the host key. */
  token?: string;
  /** Which session `current` means. Defaults to the token's own session. */
  sessionId?: string;
  fetch?: typeof fetch;
};

export class PproError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfter?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    retryAfter?: number,
  ) {
    super(message);
    this.name = "PproError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

export type WaitOptions = {
  /** Seconds to wait for something new, up to 25. */
  wait?: number;
  types?: string[];
  signal?: AbortSignal;
};

/** The client for this app: sessions typed with the beauty advisor's state. */
export type BeautyAdvisorClient = AdvisorClient<BeautyState, BeautyView>;

export class AdvisorClient<App = unknown, View = Record<string, unknown>> {
  readonly baseUrl: string;
  private token?: string;
  private readonly session: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.session = options.sessionId ?? "current";
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private path(suffix = "") {
    return `${API_PREFIX}/sessions/${this.session}${suffix}`;
  }

  async request<T>(
    method: string,
    path: string,
    options: {
      json?: unknown;
      body?: BodyInit;
      type?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      /** How to read the response body. Default: JSON. */
      as?: "json" | "text" | "blob";
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let body = options.body;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.type) headers["Content-Type"] = options.type;
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers,
      body,
      signal: options.signal,
    });
    if (!response.ok) throw await errorFrom(response);
    if (response.status === 204) return undefined as T;
    if (options.as === "blob") return (await response.blob()) as T;
    if (options.as === "text") return (await response.text()) as T;
    return (await response.json()) as T;
  }

  // --- Reading ---------------------------------------------------------------

  manifest(): Promise<Manifest> {
    return this.request("GET", "/.well-known/ppro-app.json");
  }

  state(options: { messages?: number } = {}): Promise<Session<App, View>> {
    const query =
      options.messages === undefined ? "" : `?messages=${options.messages}`;
    return this.request("GET", this.path(query));
  }

  /** The advisor's briefing, rendered for the session as it stands now. */
  async instructions(style: "chat" | "call" = "chat"): Promise<string> {
    const reply = await this.request<{ text: string }>(
      "GET",
      this.path(`/instructions?style=${style}`),
    );
    return reply.text;
  }

  /** The tools in the format your framework expects. */
  tools(format: ToolFormat = "native"): Promise<unknown[]> {
    return this.request("GET", this.path(`/tools?format=${format}`));
  }

  // --- Acting as the advisor ---------------------------------------------------

  /** Calls a tool. A refusal (no photo yet, budget spent) is `ok: false`, not an exception. */
  tool<Args extends object = Record<string, unknown>>(
    name: string,
    args?: Args,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<ToolResponse> {
    return this.request(
      "POST",
      this.path(`/tools/${encodeURIComponent(name)}`),
      {
        json: args ?? {},
        headers: options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : undefined,
        signal: options.signal,
      },
    );
  }

  /** Sends a chat message as the advisor. */
  async say(
    text: string,
  ): Promise<{ seq: number; body: string; spoken?: string }> {
    const reply = await this.request<{
      message: { seq: number; body: string; spoken?: string };
    }>("POST", this.path("/messages"), { json: { text } });
    return reply.message;
  }

  async presence(state: Presence): Promise<void> {
    await this.request("PUT", this.path("/presence"), { json: { state } });
  }

  // --- Listening ----------------------------------------------------------------

  /** One long-poll: events newer than `after`, waiting up to `wait` seconds. */
  poll(
    after: number,
    options: WaitOptions = {},
  ): Promise<{ events: PproEvent[]; rev: number; phase: "active" | "ended" }> {
    const query = new URLSearchParams({
      after: String(after),
      wait: String(options.wait ?? 20),
    });
    if (options.types?.length) query.set("types", options.types.join(","));
    return this.request("GET", this.path(`/events?${query}`), {
      signal: options.signal,
    });
  }

  /**
   * Events as they happen, until the session ends or `signal` aborts. Resumes
   * after `after` (the `rev` of a snapshot you hold). Uses long-polling, so it
   * works through any proxy. Ends after the `session.ended` event.
   */
  events(
    options: { after?: number; types?: string[]; signal?: AbortSignal } = {},
  ): AsyncGenerator<PproEvent> {
    // The starting point is read now, when this is called, not when the first
    // event is asked for: otherwise events that happen in between are missed.
    const start =
      options.after !== undefined
        ? Promise.resolve(options.after)
        : this.state({ messages: 0 }).then((session) => session.rev);
    start.catch(() => undefined);
    return this.stream(start, options);
  }

  private async *stream(
    start: Promise<number>,
    options: { types?: string[]; signal?: AbortSignal },
  ): AsyncGenerator<PproEvent> {
    let after = await start;
    while (!options.signal?.aborted) {
      let batch;
      try {
        batch = await this.poll(after, {
          wait: 20,
          types: options.types,
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      }
      for (const event of batch.events) {
        after = Math.max(after, event.rev);
        yield event;
        if (event.type === "session.ended") return;
      }
      after = Math.max(after, batch.rev);
      if (batch.phase === "ended" && !batch.events.length) return;
    }
  }

  /** Image bytes (a photo or a result image). The client may always read them. */
  image(imageId: string): Promise<Blob> {
    return this.request(
      "GET",
      this.path(`/images/${encodeURIComponent(imageId)}`),
      {
        as: "blob",
      },
    );
  }

  /** The consultation as plain text, for the client to keep. */
  transcript(): Promise<string> {
    return this.request("GET", this.path("/transcript.txt"), { as: "text" });
  }

  // --- Acting as the client ------------------------------------------------------

  consent(input: { adult?: boolean; photoAnalysis?: boolean }) {
    return this.request("POST", this.path("/consent"), {
      json: { adult: input.adult, photo_analysis: input.photoAnalysis },
    });
  }

  async uploadPhoto(bytes: Blob | Uint8Array, type = "image/jpeg") {
    const reply = await this.request<{ photo: { id: string } }>(
      "POST",
      this.path("/photos"),
      { body: bytes as BodyInit, type },
    );
    return reply.photo;
  }

  /** Deletes a photo and every image made from it. */
  deletePhoto(photoId: string) {
    return this.request<void>(
      "DELETE",
      this.path(`/photos/${encodeURIComponent(photoId)}`),
    );
  }

  clientMessage(text: string) {
    return this.request("POST", this.path("/messages"), { json: { text } });
  }

  uiEvent(event: Record<string, unknown>) {
    return this.request("POST", this.path("/ui-events"), { json: event });
  }

  /** Ends the consultation. Photos and result images are deleted. */
  end() {
    return this.request("DELETE", this.path());
  }
}

/** Host-side calls: creating sessions. Never run this in a browser. */
export class HostClient {
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly fetcher: typeof fetch;

  constructor(options: {
    baseUrl: string;
    hostKey: string;
    fetch?: typeof fetch;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.key = options.hostKey;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private async call<T>(
    method: string,
    path: string,
    json?: unknown,
  ): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(json === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    if (!response.ok) throw await errorFrom(response);
    return (await response.json()) as T;
  }

  /** Creates a session. Give `tokens.agent` to the advisor, `urls.client` to the browser. */
  createSession(
    input: {
      advisor?: { name?: string; pronouns?: string; persona?: string };
      client?: { display_name?: string };
      minutes?: number;
      agent_vision?: boolean;
      locale?: string;
      host_origin?: string;
      units?: number;
      consent?: { adult?: boolean; photo_analysis?: boolean };
    } = {},
  ): Promise<CreatedSession> {
    return this.call("POST", `${API_PREFIX}/sessions`, input);
  }

  mintToken(sessionId: string, role: "agent" | "client") {
    return this.call<{ token: string; url?: string; expiresAt: number }>(
      "POST",
      `${API_PREFIX}/sessions/${sessionId}/tokens`,
      { role },
    );
  }

  /** The advisor's client for a session created above. */
  advisor(created: CreatedSession, fetcher?: typeof fetch) {
    return new AdvisorClient<BeautyState, BeautyView>({
      baseUrl: this.baseUrl,
      token: created.tokens.agent,
      sessionId: created.session.id,
      fetch: fetcher ?? this.fetcher,
    });
  }
}

export type CreatedSession = {
  session: Session;
  tokens: { agent: string; client: string };
  urls: { client: string; api: string; events: string; mcp: string | null };
};

async function errorFrom(response: Response) {
  let code = "http_error";
  let message = `${response.status} ${response.statusText}`;
  let details: unknown;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
    details = body.error?.details;
  } catch {
    // The body was not JSON; keep the status text.
  }
  const retry = Number(response.headers.get("retry-after"));
  return new PproError(
    response.status,
    code,
    message,
    details,
    Number.isFinite(retry) && retry > 0 ? retry : undefined,
  );
}
