import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import "./helpers.ts";
import { loadConfig } from "../src/server/config.ts";

// loadConfig reads secrets from the `env` argument and everything else from
// process.env. These tests set process.env for the length of one call.
const TOUCHED = [
  "NODE_ENV",
  "PORT",
  "PPRO_PUBLIC_URL",
  "PPRO_STANDALONE",
] as const;
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function setEnv(vars: Partial<Record<(typeof TOUCHED)[number], string>>) {
  for (const key of TOUCHED) delete process.env[key];
  Object.assign(process.env, vars);
}

const SECRET = "s".repeat(40);
const HOST_KEY = "h".repeat(30);

describe("configuration", () => {
  it("generates its own secrets in development", () => {
    setEnv({});
    const config = loadConfig({} as NodeJS.ProcessEnv);
    assert.equal(config.production, false);
    assert.ok(config.signingSecret.length >= 32);
    assert.match(config.hostKey ?? "", /^host_/);
    assert.equal(config.hostKeyGenerated, true);
    assert.equal(config.standalone, true);
    assert.equal(config.publicUrl, "http://localhost:8787");
  });

  it("starts in production with everything set, and keeps only the origin", () => {
    setEnv({
      NODE_ENV: "production",
      PPRO_PUBLIC_URL: "https://beauty.example.com/some/path?x=1",
    });
    const config = loadConfig({
      PPRO_SIGNING_SECRET: SECRET,
      PPRO_HOST_KEY: HOST_KEY,
    } as NodeJS.ProcessEnv);
    assert.equal(config.production, true);
    assert.equal(config.publicUrl, "https://beauty.example.com");
    assert.equal(config.hostKey, HOST_KEY);
    assert.equal(config.hostKeyGenerated, false);
    assert.equal(config.standalone, false);
  });

  it("refuses to start in production without a signing secret", () => {
    setEnv({
      NODE_ENV: "production",
      PPRO_PUBLIC_URL: "https://beauty.example.com",
    });
    assert.throws(
      () => loadConfig({ PPRO_HOST_KEY: HOST_KEY } as NodeJS.ProcessEnv),
      /PPRO_SIGNING_SECRET is required in production/,
    );
  });

  it("refuses to start in production without a public URL", () => {
    setEnv({ NODE_ENV: "production" });
    const env = {
      PPRO_SIGNING_SECRET: SECRET,
      PPRO_HOST_KEY: HOST_KEY,
    } as NodeJS.ProcessEnv;
    assert.throws(() => loadConfig(env), /PPRO_PUBLIC_URL is required/);
    setEnv({ NODE_ENV: "production", PPRO_PUBLIC_URL: "not a url" });
    assert.throws(() => loadConfig(env), /PPRO_PUBLIC_URL is required/);
    setEnv({ NODE_ENV: "production", PPRO_PUBLIC_URL: "ftp://x.example" });
    assert.throws(() => loadConfig(env), /PPRO_PUBLIC_URL is required/);
  });

  it("refuses to start in production with no way to create a session", () => {
    setEnv({
      NODE_ENV: "production",
      PPRO_PUBLIC_URL: "https://beauty.example.com",
    });
    const env = { PPRO_SIGNING_SECRET: SECRET } as NodeJS.ProcessEnv;
    assert.throws(() => loadConfig(env), /PPRO_HOST_KEY is required/);
    // A deployment that is only the standalone demo needs no host key.
    setEnv({
      NODE_ENV: "production",
      PPRO_PUBLIC_URL: "https://beauty.example.com",
      PPRO_STANDALONE: "true",
    });
    const config = loadConfig(env);
    assert.equal(config.hostKey, null);
    assert.equal(config.standalone, true);
  });

  it("rejects a weak secret or host key in any mode", () => {
    setEnv({});
    assert.throws(
      () => loadConfig({ PPRO_SIGNING_SECRET: "short" } as NodeJS.ProcessEnv),
      /at least 32 characters/,
    );
    assert.throws(
      () =>
        loadConfig({
          PPRO_SIGNING_SECRET: SECRET,
          PPRO_HOST_KEY: "short",
        } as NodeJS.ProcessEnv),
      /at least 24 characters/,
    );
  });

  it("never accepts a wildcard origin", () => {
    setEnv({});
    for (const origins of ["*", "https://a.example,*", "https://*.example"])
      assert.throws(
        () =>
          loadConfig({
            PPRO_SIGNING_SECRET: SECRET,
            PPRO_ALLOWED_ORIGINS: origins,
          } as NodeJS.ProcessEnv),
        /never a wildcard/,
      );
    const config = loadConfig({
      PPRO_SIGNING_SECRET: SECRET,
      PPRO_ALLOWED_ORIGINS: "https://a.example/, https://b.example:8443",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(config.allowedOrigins, [
      "https://a.example",
      "https://b.example:8443",
    ]);
  });
});
