import { randomBytes } from "node:crypto";
import { envFlag, envNumber, envString, isProduction } from "../support/env.ts";

// Server configuration, read once at startup. Secrets come only from the
// environment. In development missing secrets are generated for the run. In
// production a missing or weak secret stops the server from starting, and so
// does a missing public URL or a missing host key (unless the bundled web app
// may start its own demo sessions).

export type Config = {
  production: boolean;
  port: number;
  /** Public origin of this deployment, used in launch links. */
  publicUrl: string;
  signingSecret: Buffer;
  /** Key a host uses to create sessions, or null when none is configured. */
  hostKey: string | null;
  /** True when the host key was generated for this run (development only). */
  hostKeyGenerated: boolean;
  /** Origins allowed to embed the app and to call the API from a browser. */
  allowedOrigins: string[];
  /** Whether the bundled web app may start its own demo sessions. */
  standalone: boolean;
  mcp: boolean;
  defaultMinutes: number;
  maxMinutes: number;
  /** How long an ended session stays readable (transcript download). */
  endedRetentionMs: number;
};

function origin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Config> = {},
): Config {
  const production = isProduction();
  const port = envNumber("PORT", 8787);
  const configuredUrl = origin(envString("PPRO_PUBLIC_URL") ?? "");
  if (production && !configuredUrl)
    throw new Error(
      "PPRO_PUBLIC_URL is required in production: the public origin of this deployment, for example https://beauty.example.com.",
    );
  const publicUrl = configuredUrl ?? `http://localhost:${port}`;

  let secret = env.PPRO_SIGNING_SECRET?.trim();
  if (!secret) {
    if (production)
      throw new Error(
        "PPRO_SIGNING_SECRET is required in production (32 or more random characters).",
      );
    secret = randomBytes(32).toString("base64url");
  } else if (secret.length < 32) {
    throw new Error("PPRO_SIGNING_SECRET must be at least 32 characters.");
  }

  let hostKey = env.PPRO_HOST_KEY?.trim() || null;
  let hostKeyGenerated = false;
  if (hostKey && hostKey.length < 24)
    throw new Error("PPRO_HOST_KEY must be at least 24 characters.");
  if (!hostKey && !production) {
    hostKey = `host_${randomBytes(24).toString("base64url")}`;
    hostKeyGenerated = true;
  }

  const allowedOrigins = (env.PPRO_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => origin(item))
    .filter((item): item is string => Boolean(item));
  if ((env.PPRO_ALLOWED_ORIGINS ?? "").includes("*"))
    throw new Error(
      "PPRO_ALLOWED_ORIGINS must list exact origins, never a wildcard.",
    );

  const standalone = envFlag("PPRO_STANDALONE", !production);
  if (production && !hostKey && !standalone)
    throw new Error(
      "PPRO_HOST_KEY is required in production (24 or more characters), because nothing else can create a session. Set PPRO_STANDALONE=true to let the bundled web app start demo sessions instead.",
    );
  const config: Config = {
    production,
    port,
    publicUrl,
    signingSecret: Buffer.from(secret, "utf8"),
    hostKey,
    hostKeyGenerated,
    allowedOrigins,
    standalone,
    mcp: envFlag("PPRO_MCP", true),
    defaultMinutes: envNumber("PPRO_SESSION_MINUTES", 30),
    maxMinutes: envNumber("PPRO_MAX_SESSION_MINUTES", 180),
    endedRetentionMs: 10 * 60_000,
    ...overrides,
  };
  return config;
}
