import type { Context } from "hono";
import { z } from "zod";
import { ApiError } from "../protocol/errors.ts";
import type { Config } from "./config.ts";
import { sameSecret, verifyToken } from "./tokens.ts";

// Small HTTP helpers shared by the routes: authentication, bounded body
// reading and validated JSON parsing.

export type Auth =
  { role: "host" } | { role: "agent" | "client"; sessionId: string };

export type RoleName = Auth["role"];

/** The caller's identity from `Authorization: Bearer`, or null. */
export function authenticate(
  c: Context,
  config: Config,
  now: () => number = Date.now,
): Auth | null {
  const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  if (!match) return null;
  const token = match[1];
  if (config.hostKey && sameSecret(token, config.hostKey))
    return { role: "host" };
  const payload = verifyToken(config.signingSecret, token, now());
  return payload ? { role: payload.role, sessionId: payload.sid } : null;
}

/** Authenticates and checks the caller may act in the way `allowed` names. */
export function authorize(
  c: Context,
  config: Config,
  allowed: readonly RoleName[],
  sessionParam?: string,
  now: () => number = Date.now,
): { auth: Auth; sessionId: string | null } {
  const auth = authenticate(c, config, now);
  if (!auth)
    throw new ApiError(401, "unauthorized", "Send a valid bearer token.", {
      headers: { "WWW-Authenticate": 'Bearer realm="ppro-app"' },
    });
  if (!allowed.includes(auth.role))
    throw new ApiError(
      403,
      "forbidden",
      `A ${auth.role} token cannot do this.`,
    );
  if (sessionParam === undefined) return { auth, sessionId: null };
  let sessionId = sessionParam;
  if (sessionParam === "current") {
    if (auth.role === "host")
      throw new ApiError(
        400,
        "invalid_request",
        "A host key has no current session. Use the session id.",
      );
    sessionId = auth.sessionId;
  }
  // Another session's token learns nothing about whether this one exists.
  if (auth.role !== "host" && auth.sessionId !== sessionId)
    throw new ApiError(404, "not_found", "No such session.");
  return { auth, sessionId };
}

/** Reads a request body into memory without ever holding more than maxBytes. */
export async function readBody(request: Request, maxBytes: number) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new ApiError(413, "payload_too_large", "That request is too large.");
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(
        413,
        "payload_too_large",
        "That request is too large.",
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

/**
 * Parses a JSON request body against a schema. An empty body is read as `{}`
 * so calls with no arguments need no body.
 */
export async function readJson<T extends z.ZodType>(
  c: Context,
  schema: T,
  maxBytes: number,
): Promise<z.infer<T>> {
  const body = await readBody(c.req.raw, maxBytes);
  let raw: unknown = {};
  if (body.byteLength) {
    if (!/\bjson\b/i.test(c.req.header("content-type") ?? ""))
      throw new ApiError(
        415,
        "unsupported_media_type",
        "Send the body as application/json.",
      );
    try {
      raw = JSON.parse(body.toString("utf8"));
    } catch {
      throw new ApiError(400, "invalid_request", "The body is not valid JSON.");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      422,
      "invalid_request",
      `Invalid request: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
        .join("; ")}`,
      {
        details: parsed.error.issues.slice(0, 10).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    );
  return parsed.data;
}

/** A non-negative integer query parameter, or the fallback. */
export function intParam(value: string | undefined, fallback: number) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new ApiError(
      400,
      "invalid_request",
      "Expected a non-negative integer.",
    );
  return number;
}
