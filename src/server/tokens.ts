import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "../protocol/types.ts";

// Session tokens: `p1.<payload>.<signature>`. The payload is base64url JSON
// {sid, role, exp}; the signature is HMAC-SHA256 over `p1.<payload>` with the
// server's signing secret. A token speaks for one role in one session and
// expires with the session. Tokens go in the Authorization header, never in a
// query string; the web app receives its client token in the URL *fragment*,
// which browsers do not send to servers or log.

const PREFIX = "p1";

export type TokenPayload = {
  sid: string;
  role: "agent" | "client";
  /** Expiry, in seconds since the epoch. */
  exp: number;
};

function sign(secret: Buffer, body: string) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function mintToken(secret: Buffer, payload: TokenPayload): string {
  const body = `${PREFIX}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${sign(secret, body)}`;
}

/** The payload of a valid, unexpired token, or null. Constant-time compare. */
export function verifyToken(
  secret: Buffer,
  token: string,
  now = Date.now(),
): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const { sid, role, exp } = payload as Record<string, unknown>;
  if (
    typeof sid !== "string" ||
    (role !== "agent" && role !== "client") ||
    typeof exp !== "number" ||
    exp * 1000 < now
  )
    return null;
  return { sid, role, exp };
}

/** Constant-time string comparison for static keys. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type Principal =
  { role: "host" } | { role: Exclude<Role, "host">; sessionId: string };
