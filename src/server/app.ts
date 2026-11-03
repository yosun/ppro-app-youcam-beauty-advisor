import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  API_PREFIX,
  LIMITS,
  MANIFEST_PATH,
  MCP_PATH,
} from "../protocol/constants.ts";
import { ApiError, errorBody } from "../protocol/errors.ts";
import {
  TOOL_FORMATS,
  formatTools,
  type ToolFormat,
} from "../protocol/formats.ts";
import { allToolDeclarations, buildManifest } from "../protocol/manifest.ts";
import {
  consentBody,
  createSessionBody,
  demoSessionBody,
  messageBody,
  mintTokenBody,
  presenceBody,
  uiEventBody,
} from "../protocol/schemas.ts";
import type { Config } from "./config.ts";
import {
  authorize as authorizeRequest,
  intParam,
  readBody,
  readJson,
  type RoleName,
} from "./http.ts";
import { mountMcp } from "./mcp.ts";
import { WindowCounter } from "./rate-limit.ts";
import type { Runtime } from "./runtime.ts";
import { serveWeb } from "./static.ts";

// The HTTP surface of PPRO App API v1. Every route is a thin wrapper over a
// Runtime method: authenticate, check the role, validate, call, respond.

const demoLimiter = new WindowCounter(20, 60 * 60_000);

const IMAGE_TYPES = /^image\/(jpeg|png|webp)$|^application\/octet-stream$/i;

export function createApp<
  State extends Record<string, unknown>,
  View extends Record<string, unknown>,
>(runtime: Runtime<State, View>, config: Config) {
  const app = new Hono();
  const mode = () => runtime.app.engineMode();
  // Tokens expire against the runtime's clock, the same one sessions use.
  const authorize = (
    c: Context,
    allowed: readonly RoleName[],
    sessionParam?: string,
  ) => authorizeRequest(c, config, allowed, sessionParam, runtime.now);
  const manifest = () =>
    buildManifest(runtime.app, {
      engine: mode(),
      mcp: config.mcp,
      standalone: config.standalone,
      embedding: config.allowedOrigins.length > 0,
    });

  // --- Cross-cutting ---------------------------------------------------------

  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    const path = new URL(c.req.url).pathname.replace(
      /\/(ses|pho|img)_[A-Za-z0-9]{22}/g,
      "/:$1",
    );
    if (path.startsWith(API_PREFIX) || path === MCP_PATH)
      console.log(
        JSON.stringify({
          event: "request",
          method: c.req.method,
          path,
          status: c.res.status,
          ms: Date.now() - started,
        }),
      );
  });

  app.use("*", async (c, next) => {
    await next();
    const headers = c.res.headers;
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set(
      "Permissions-Policy",
      "camera=(self), microphone=(), geolocation=()",
    );
    const url = new URL(c.req.url);
    const isApi =
      url.pathname.startsWith(API_PREFIX) ||
      url.pathname === MCP_PATH ||
      url.pathname === MANIFEST_PATH;
    if (isApi) {
      if (!headers.has("Cache-Control"))
        headers.set("Cache-Control", "no-store");
    } else if (/text\/html/i.test(headers.get("content-type") ?? "")) {
      headers.set(
        "Content-Security-Policy",
        `frame-ancestors 'self' ${config.allowedOrigins.join(" ")}; base-uri 'self'; object-src 'none'`.replace(
          /\s+;/g,
          ";",
        ),
      );
    }
  });

  // The manifest is public discovery information.
  app.use(
    MANIFEST_PATH,
    cors({ origin: "*", allowMethods: ["GET"], maxAge: 3600 }),
  );
  // The rest of the API answers only the origins the operator allowed.
  app.use(
    `${API_PREFIX}/*`,
    cors({
      origin: (origin) =>
        config.allowedOrigins.includes(origin) ? origin : "",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "Idempotency-Key",
        "Last-Event-ID",
      ],
      exposeHeaders: ["Retry-After", "Idempotent-Replayed"],
      maxAge: 600,
    }),
  );

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      for (const [name, value] of Object.entries(error.headers ?? {}))
        c.header(name, value);
      return c.json(errorBody(error), error.status as 400);
    }
    console.error(
      JSON.stringify({
        event: "unhandled_error",
        error: error instanceof Error ? error.name : "Error",
      }),
    );
    return c.json(
      errorBody(new ApiError(500, "internal_error", "Something went wrong.")),
      500,
    );
  });

  // --- Discovery -------------------------------------------------------------

  const serveManifest = (c: Context) => c.json(manifest());
  app.get(MANIFEST_PATH, serveManifest);
  app.get(`${API_PREFIX}/manifest`, serveManifest);

  app.get(`${API_PREFIX}/health`, (c) =>
    c.json({
      ok: true,
      protocol: "ppro-app/1",
      app: runtime.app.id,
      version: runtime.app.version,
      engine: mode(),
    }),
  );

  // --- Sessions --------------------------------------------------------------

  const launchUrl = (id: string, clientToken: string) =>
    `${config.publicUrl}/?s=${id}#t=${clientToken}`;

  const created = (rec: ReturnType<Runtime<State, View>["create"]>) => {
    const tokens = runtime.tokensFor(rec);
    return {
      session: runtime.snapshot(rec, "host"),
      tokens,
      urls: {
        client: launchUrl(rec.id, tokens.client),
        api: `${config.publicUrl}${API_PREFIX}`,
        events: `${config.publicUrl}${API_PREFIX}/sessions/${rec.id}/events`,
        mcp: config.mcp ? `${config.publicUrl}${MCP_PATH}` : null,
      },
    };
  };

  app.post(`${API_PREFIX}/sessions`, async (c) => {
    authorize(c, ["host"]);
    const body = await readJson(c, createSessionBody, LIMITS.jsonBodyBytes);
    let hostOrigin: string | undefined;
    if (body.host_origin) {
      let origin: string;
      try {
        origin = new URL(body.host_origin).origin;
      } catch {
        throw new ApiError(422, "invalid_request", "host_origin is not a URL.");
      }
      if (!config.allowedOrigins.includes(origin))
        throw new ApiError(
          422,
          "invalid_request",
          "host_origin must be one of the operator's PPRO_ALLOWED_ORIGINS.",
        );
      hostOrigin = origin;
    }
    const rec = runtime.create({
      advisor: body.advisor,
      client: { displayName: body.client?.display_name },
      minutes: body.minutes,
      agentVision: body.agent_vision,
      locale: body.locale,
      hostOrigin,
      units: body.units,
      consent: body.consent
        ? {
            adult: body.consent.adult,
            photoAnalysis: body.consent.photo_analysis,
          }
        : undefined,
    });
    return c.json(created(rec), 201);
  });

  // A standalone deployment lets the bundled app start its own demo session,
  // handing the browser both tokens so a developer can connect an agent.
  app.post(`${API_PREFIX}/demo/session`, async (c) => {
    if (!config.standalone)
      throw new ApiError(
        404,
        "not_found",
        "Standalone sessions are not enabled on this server.",
      );
    const address =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (!demoLimiter.hit(address))
      throw new ApiError(429, "rate_limited", "Too many demo sessions.", {
        headers: { "Retry-After": "600" },
      });
    const body = await readJson(c, demoSessionBody, LIMITS.jsonBodyBytes);
    const rec = runtime.create({
      advisor: { name: body.advisor_name ?? "Your advisor" },
      client: { displayName: body.client_name },
      agentVision: body.agent_vision,
    });
    return c.json(created(rec), 201);
  });

  app.get(`${API_PREFIX}/sessions/:id`, (c) => {
    const { auth, sessionId } = authorize(
      c,
      ["host", "agent", "client"],
      c.req.param("id"),
    );
    const rec = runtime.get(sessionId as string);
    return c.json(
      runtime.snapshot(rec, auth.role, {
        messages: intParam(c.req.query("messages"), 100),
      }),
    );
  });

  app.delete(`${API_PREFIX}/sessions/:id`, (c) => {
    const { auth, sessionId } = authorize(
      c,
      ["host", "agent", "client"],
      c.req.param("id"),
    );
    const rec = runtime.endSession(sessionId as string, auth.role);
    return c.json(runtime.snapshot(rec, auth.role, { messages: 0 }));
  });

  app.post(`${API_PREFIX}/sessions/:id/tokens`, async (c) => {
    const { sessionId } = authorize(c, ["host"], c.req.param("id"));
    const body = await readJson(c, mintTokenBody, LIMITS.jsonBodyBytes);
    const rec = runtime.get(sessionId as string);
    const token = runtime.tokenFor(rec, body.role);
    return c.json({
      role: body.role,
      token,
      expiresAt: rec.expiresAt + config.endedRetentionMs,
      ...(body.role === "client" ? { url: launchUrl(rec.id, token) } : {}),
    });
  });

  // --- Transcript ------------------------------------------------------------

  app.get(`${API_PREFIX}/sessions/:id/transcript.txt`, (c) => {
    const { sessionId } = authorize(c, ["host", "client"], c.req.param("id"));
    const rec = runtime.get(sessionId as string);
    return c.body(runtime.transcriptText(rec), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="consultation.txt"',
    });
  });

  app.post(`${API_PREFIX}/sessions/:id/messages`, async (c) => {
    const { auth, sessionId } = authorize(
      c,
      ["host", "agent", "client"],
      c.req.param("id"),
    );
    const body = await readJson(c, messageBody, LIMITS.jsonBodyBytes);
    let message;
    if (auth.role === "agent") {
      if (body.role && body.role !== "agent")
        throw new ApiError(
          403,
          "forbidden",
          "An agent token posts agent messages.",
        );
      message = runtime.agentMessage(sessionId as string, body.text);
    } else if (auth.role === "client") {
      if (body.role && body.role !== "client")
        throw new ApiError(
          403,
          "forbidden",
          "A client token posts client messages.",
        );
      message = runtime.clientMessage(sessionId as string, body.text);
    } else {
      // A host relays what the client said (for example transcribed speech).
      if (body.role !== "client")
        throw new ApiError(
          422,
          "invalid_request",
          'A host posts on behalf of the client: set role to "client".',
        );
      message = runtime.clientMessage(sessionId as string, body.text, "host");
    }
    return c.json({ message }, 201);
  });

  app.put(`${API_PREFIX}/sessions/:id/presence`, async (c) => {
    const { sessionId } = authorize(c, ["agent"], c.req.param("id"));
    const body = await readJson(c, presenceBody, LIMITS.jsonBodyBytes);
    return c.json({
      presence: runtime.setPresence(sessionId as string, body.state),
    });
  });

  // --- Agent briefing --------------------------------------------------------

  app.get(`${API_PREFIX}/sessions/:id/instructions`, (c) => {
    const { sessionId } = authorize(c, ["host", "agent"], c.req.param("id"));
    const rec = runtime.get(sessionId as string);
    const style = c.req.query("style") === "call" ? "call" : "chat";
    return c.json({
      style,
      rev: rec.rev,
      text: runtime.instructions(rec, style),
    });
  });

  app.get(`${API_PREFIX}/sessions/:id/tools`, (c) => {
    const { sessionId } = authorize(c, ["host", "agent"], c.req.param("id"));
    runtime.get(sessionId as string);
    const format = (c.req.query("format") ?? "native") as ToolFormat;
    if (!TOOL_FORMATS.includes(format))
      throw new ApiError(
        400,
        "invalid_request",
        `format must be one of ${TOOL_FORMATS.join(", ")}.`,
      );
    return c.json(formatTools(allToolDeclarations(runtime.app), format));
  });

  // --- Tools -----------------------------------------------------------------

  app.post(`${API_PREFIX}/sessions/:id/tools/:name`, async (c) => {
    const { sessionId } = authorize(c, ["agent"], c.req.param("id"));
    const id = sessionId as string;
    const name = c.req.param("name");
    const key = c.req.header("idempotency-key")?.trim();
    if (key && !/^[A-Za-z0-9_.:-]{1,80}$/.test(key))
      throw new ApiError(
        400,
        "invalid_request",
        "Idempotency-Key must be 1-80 characters of letters, digits and _ . : -",
      );
    const args = await readJson(
      c,
      z.record(z.string(), z.unknown()),
      LIMITS.jsonBodyBytes,
    );
    const { response, replayed } = await runtime.invoke(id, name, args, {
      idempotencyKey: key,
      signal: c.req.raw.signal,
    });
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(response);
  });

  // --- Events ----------------------------------------------------------------

  app.get(`${API_PREFIX}/sessions/:id/events`, async (c) => {
    const { sessionId } = authorize(
      c,
      ["host", "agent", "client"],
      c.req.param("id"),
    );
    const id = sessionId as string;
    const rec = runtime.get(id);
    const after = intParam(
      c.req.query("after") ?? c.req.header("last-event-id"),
      0,
    );
    const types = c.req.query("types")?.split(",").filter(Boolean);
    const wantsStream = /text\/event-stream/i.test(
      c.req.header("accept") ?? "",
    );
    if (!wantsStream || c.req.query("wait") !== undefined) {
      const waitSeconds = Math.min(
        LIMITS.waitMaxSeconds,
        intParam(c.req.query("wait"), 0),
      );
      const batch = await runtime.events(id, after, {
        waitMs: waitSeconds * 1000,
        types,
        signal: c.req.raw.signal,
      });
      return c.json(batch);
    }
    // Validate the cursor before the stream starts so a bad one is a 410.
    rec.eventsAfter(after);
    return streamSSE(c, async (stream) => {
      let cursor = after;
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      while (!controller.signal.aborted) {
        const batch = await rec.waitForEvents(cursor, 15_000, {
          types,
          signal: controller.signal,
        });
        for (const event of batch.events) {
          await stream.writeSSE({
            id: String(event.rev),
            event: event.type,
            data: JSON.stringify(event),
          });
          if (event.type === "session.ended") return;
        }
        cursor = Math.max(cursor, batch.rev);
        if (!batch.events.length) await stream.write(": keepalive\n\n");
        if (batch.phase === "ended" && !batch.events.length) return;
      }
    });
  });

  // --- Client actions --------------------------------------------------------

  app.post(`${API_PREFIX}/sessions/:id/consent`, async (c) => {
    const { sessionId } = authorize(c, ["client"], c.req.param("id"));
    const body = await readJson(c, consentBody, LIMITS.jsonBodyBytes);
    return c.json({
      consent: runtime.setConsent(sessionId as string, {
        adult: body.adult,
        photoAnalysis: body.photo_analysis,
      }),
    });
  });

  app.post(`${API_PREFIX}/sessions/:id/photos`, async (c) => {
    const { sessionId } = authorize(c, ["client"], c.req.param("id"));
    const type = (c.req.header("content-type") ?? "").split(";")[0].trim();
    if (!IMAGE_TYPES.test(type))
      throw new ApiError(
        415,
        "unsupported_media_type",
        "Send the photo as the request body with Content-Type image/jpeg, image/png or image/webp.",
      );
    const bytes = await readBody(c.req.raw, LIMITS.photoUploadBytes);
    const photo = await runtime.addPhoto(sessionId as string, bytes);
    return c.json({ photo }, 201);
  });

  app.delete(`${API_PREFIX}/sessions/:id/photos/:photoId`, (c) => {
    const { sessionId } = authorize(c, ["host", "client"], c.req.param("id"));
    runtime.deletePhoto(sessionId as string, c.req.param("photoId"));
    return c.body(null, 204);
  });

  app.post(`${API_PREFIX}/sessions/:id/ui-events`, async (c) => {
    const { sessionId } = authorize(c, ["client"], c.req.param("id"));
    const event = await readJson(c, uiEventBody, LIMITS.jsonBodyBytes);
    return c.json({ ui: runtime.uiEvent(sessionId as string, event) });
  });

  // --- Images ----------------------------------------------------------------

  app.get(`${API_PREFIX}/sessions/:id/images/:imageId`, (c) => {
    const { auth, sessionId } = authorize(
      c,
      ["agent", "client"],
      c.req.param("id"),
    );
    const rec = runtime.get(sessionId as string);
    // An agent sees images only when the session was created to allow it.
    if (auth.role === "agent" && !rec.options.agentVision)
      throw new ApiError(
        403,
        "vision_disabled",
        "This session does not let the agent view images. Rely on tool results.",
      );
    const image = runtime.image(rec, c.req.param("imageId"));
    return c.body(new Uint8Array(image.bytes), 200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
    });
  });

  // --- MCP and the web app ---------------------------------------------------

  if (config.mcp) mountMcp(app, runtime, config);
  app.get("*", serveWeb);
  app.notFound((c) =>
    c.json(errorBody(new ApiError(404, "not_found", "Not found.")), 404),
  );
  return app;
}
