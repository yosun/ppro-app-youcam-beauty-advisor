import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import "./helpers.ts";
import { beautyAdvisor } from "../src/advisor/app.ts";
import { buildManifest } from "../src/protocol/manifest.ts";
import { manifestSchema } from "../src/protocol/manifest-schema.ts";
import { buildOpenApi, ROUTES } from "../src/protocol/openapi.ts";
import { EVENT_TYPES } from "../src/protocol/types.ts";
import * as schemas from "../src/protocol/schemas.ts";
import { buildFiles, yaml } from "../scripts/build-spec.ts";
import { testServer } from "./harness.ts";

const specDir = fileURLToPath(new URL("../spec/", import.meta.url));

describe("the YAML writer", () => {
  it("reads back as exactly what was written, for the awkward cases", () => {
    const value = {
      ref: { $ref: "#/components/schemas/Thing" },
      "path/{id}": { get: { tags: ["a", "b"], empty: [], none: {} } },
      words: [
        "true",
        "false",
        "null",
        "yes",
        "no",
        "on",
        "off",
        "~",
        "123",
        "1.5",
        "0x1F",
        "-",
        "- x",
      ],
      punctuation: [
        "a: b",
        "a #b",
        "#lead",
        "'q'",
        '"d"',
        "@at",
        "`tick`",
        "*star",
        "&amp",
        "!bang",
        "%pct",
        "|pipe",
        ">gt",
        "{b}",
        "[b]",
        "a,b",
        "?q",
        "key:",
      ],
      multiline: "first line\nsecond line\n  indented\nlast",
      unicode: "naïve — “quoted” 日本語 😀",
      nums: [0, -1, 2.5, 1e21],
      flags: [true, false, null],
      nested: { a: { b: { c: [{ d: 1 }, { e: [1, 2] }] } } },
      trailing: "ends with space ",
    };
    const text = yaml(value);
    assert.deepEqual(parse(text), value);
  });

  it("keeps a leading # from becoming a comment", () => {
    assert.deepEqual(parse(yaml({ $ref: "#/x/y" })), { $ref: "#/x/y" });
  });
});

describe("the generated OpenAPI document", () => {
  const doc = buildOpenApi(beautyAdvisor) as any;

  it("survives a round trip through the written YAML", async () => {
    const files = await buildFiles();
    assert.deepEqual(
      parse(files.get("openapi.yaml")!),
      JSON.parse(JSON.stringify(doc)),
    );
  });

  it("resolves every reference it makes", () => {
    const text = JSON.stringify(doc);
    const refs = [
      ...text.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g),
    ].map((m) => m[1]);
    assert.ok(refs.length > 20);
    for (const name of new Set(refs))
      assert.ok(doc.components.schemas[name], `missing component ${name}`);
  });

  it("states how every operation is authenticated", () => {
    for (const [path, methods] of Object.entries<any>(doc.paths))
      for (const [method, operation] of Object.entries<any>(methods))
        assert.ok(
          Array.isArray(operation.security),
          `${method} ${path} has no security statement`,
        );
    assert.deepEqual(doc.paths["/ppro/v1/health"].get.security, []);
    assert.deepEqual(doc.paths["/ppro/v1/sessions"].post.security, [
      { bearer: [] },
    ]);
  });

  it("gives every operation a unique id", () => {
    const ids = ROUTES.map((route) => route.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("the routes the document promises", () => {
  it("exist on the server, and answer to the roles the document names", async () => {
    const t = testServer();
    const s = await t.newSession();
    const tokens = {
      host: "host_key_for_tests_0123456789abcdef",
      agent: s.agent,
      client: s.client,
    };
    for (const route of ROUTES) {
      if (route.path === "/mcp" || route.path.endsWith("ppro-app.json"))
        continue;
      const path = route.path
        .replace("{id}", s.id)
        .replace("{name}", "ui_notice")
        .replace("{photoId}", "pho_AAAAAAAAAAAAAAAAAAAAAA")
        .replace("{imageId}", "img_AAAAAAAAAAAAAAAAAAAAAA");
      const method = route.method.toUpperCase();
      const none = await t.call(method, path);
      if (route.roles === "public") {
        assert.notEqual(
          none.status,
          401,
          `${method} ${route.path} should be public`,
        );
        continue;
      }
      assert.equal(
        none.status,
        401,
        `${method} ${route.path} should need a token`,
      );
      for (const role of ["host", "agent", "client"] as const) {
        if (route.roles.includes(role)) continue;
        const response = await t.call(method, path, { token: tokens[role] });
        assert.equal(
          response.status,
          403,
          `${method} ${route.path} should refuse a ${role} token`,
        );
      }
    }
  });

  it("covers every route the server registers", async () => {
    const source = await readFile(
      new URL("../src/server/app.ts", import.meta.url),
      "utf8",
    );
    const registered = [
      ...source.matchAll(
        /app\.(get|post|put|delete)\(\s*`?\$?\{?(?:API_PREFIX\}|MANIFEST_PATH)?([^`",)]*)/g,
      ),
    ];
    assert.ok(registered.length > 10);
    const documented = new Set(
      ROUTES.map(
        (route) => `${route.method} ${route.path.replace(/\{(\w+)\}/g, ":$1")}`,
      ),
    );
    const found = [
      ...source.matchAll(
        /app\.(get|post|put|delete)\(\s*[`"]?(\$\{API_PREFIX\}[^`",]*|\$\{MANIFEST_PATH\}|MANIFEST_PATH)/g,
      ),
    ]
      .map((m) => ({ method: m[1], raw: m[2] }))
      .filter(
        (m) => m.raw !== "MANIFEST_PATH" && !m.raw.includes("MANIFEST_PATH"),
      )
      .map((m) => `${m.method} ${m.raw.replace("${API_PREFIX}", "/ppro/v1")}`);
    for (const route of found)
      assert.ok(
        documented.has(route),
        `the server has ${route} but the document does not`,
      );
  });
});

describe("the manifest schema", () => {
  const manifest = buildManifest(beautyAdvisor, {
    engine: "simulated",
    mcp: true,
    standalone: true,
    embedding: true,
  });

  it("accepts this app's manifest, as built and as served", async () => {
    assert.ok(manifestSchema.safeParse(manifest).success);
    const t = testServer();
    const served = await t.data("GET", "/.well-known/ppro-app.json");
    const result = manifestSchema.safeParse(served);
    assert.ok(result.success, JSON.stringify(result.error?.issues.slice(0, 3)));
  });

  it("rejects a manifest that breaks the standard", () => {
    const wrong = (change: (m: any) => void) => {
      const copy = structuredClone(manifest) as any;
      change(copy);
      return manifestSchema.safeParse(copy).success;
    };
    assert.equal(
      wrong(() => undefined),
      true,
    );
    assert.equal(
      wrong((m) => (m.protocol = "ppro-app/2")),
      false,
    );
    assert.equal(
      wrong((m) => delete m.advisor.guardrails),
      false,
    );
    assert.equal(
      wrong((m) => (m.advisor.guardrails = [])),
      false,
    );
    assert.equal(
      wrong((m) => (m.tools[0].name = "Bad Name")),
      false,
    );
    assert.equal(
      wrong((m) => (m.tools[0].group = "other")),
      false,
    );
    assert.equal(
      wrong((m) => (m.tools = [])),
      false,
    );
    assert.equal(
      wrong((m) => (m.screens = [])),
      false,
    );
    assert.equal(
      wrong((m) => (m.capabilities.engine.mode = "fake")),
      false,
    );
    assert.equal(
      wrong((m) => (m.auth.scheme = "basic")),
      false,
    );
  });

  it("documents every event type once", () => {
    assert.deepEqual(
      manifest.events.map((e) => e.type),
      [...EVENT_TYPES],
    );
    assert.deepEqual(
      Object.keys(schemas.eventSchemas).sort(),
      [...EVENT_TYPES].sort(),
    );
  });

  it("has a tool for everything the instructions tell the advisor to call", async () => {
    const t = testServer();
    const s = await t.newSession();
    const { text } = await t.data<{ text: string }>(
      "GET",
      `${s.base}/instructions`,
      { token: s.agent },
    );
    const names = new Set(manifest.tools.map((tool) => tool.name));
    const mentioned = [...text.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)].map(
      (m) => m[1],
    );
    const toolish = mentioned.filter(
      (word) =>
        /^(analyze|try_on|list|recommend|present|ui|set|get|wait|end)_/.test(
          word,
        ) || word === "say",
    );
    assert.ok(toolish.length >= 8);
    for (const word of new Set(toolish))
      assert.ok(
        names.has(word),
        `instructions mention ${word}, which is not a tool`,
      );
  });
});

describe("the error vocabularies", () => {
  async function sources() {
    const { glob } = await import("node:fs/promises");
    const files: string[] = [];
    for await (const file of glob("src/**/*.ts", {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
    }))
      if (!file.endsWith("protocol/errors.ts")) files.push(file);
    const root = fileURLToPath(new URL("../", import.meta.url));
    return (
      await Promise.all(files.map((file) => readFile(`${root}${file}`, "utf8")))
    ).join("\n");
  }

  it("lists exactly the HTTP error codes the server can send", async () => {
    const { ERROR_CODES } = await import("../src/protocol/errors.ts");
    const code = await sources();
    const used = new Set(
      [...code.matchAll(/new ApiError\(\s*\d+,\s*"([a-z_]+)"/g)].map(
        (m) => m[1],
      ),
    );
    for (const declared of ERROR_CODES)
      assert.ok(used.has(declared), `${declared} is declared but never sent`);
    for (const sent of used)
      assert.ok(
        (ERROR_CODES as readonly string[]).includes(sent),
        `${sent} is sent but not declared`,
      );
  });

  it("lists exactly the codes a tool can report", async () => {
    const { TOOL_ERROR_CODES } = await import("../src/protocol/errors.ts");
    const code = await sources();
    const used = new Set([
      ...[...code.matchAll(/new ToolFail\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
      ...[...code.matchAll(/\brefuse\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
      ...[...code.matchAll(/\bfailure\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
      // `say` reports a blocked message through the ApiError code.
      "content_blocked",
      // YouCam's own codes are surfaced under their own name only when they are photo problems.
    ]);
    for (const sent of used)
      assert.ok(
        (TOOL_ERROR_CODES as readonly string[]).includes(sent),
        `${sent} is reported but not declared`,
      );
    for (const declared of TOOL_ERROR_CODES)
      assert.ok(
        used.has(declared),
        `${declared} is declared but never reported`,
      );
  });
});

describe("the committed spec files", () => {
  it("match what the code generates", async () => {
    const files = await buildFiles();
    for (const [name, content] of files) {
      const committed = await readFile(`${specDir}${name}`, "utf8").catch(
        () => null,
      );
      assert.equal(
        committed,
        content,
        `spec/${name} is stale: run npm run spec:build`,
      );
    }
  });
});
