import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import "./helpers.ts";
import { APP_VERSION } from "../src/protocol/constants.ts";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("package metadata", () => {
  it("keeps the app version in step with package.json", () => {
    assert.equal(APP_VERSION, pkg.version);
  });
});

// docs/ARCHITECTURE.md describes these layers. The generic runtime must stay
// usable for a second app, and the code the browser bundles must stay free of
// Node-only modules.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ALLOWED: Record<string, string[]> = {
  protocol: [],
  support: ["protocol"],
  advisor: ["protocol", "support"],
  server: ["protocol", "support"],
  // The SDK names the advisor's state types and nothing else of it.
  client: ["protocol", "advisor"],
  web: ["protocol", "client", "advisor"],
};
/** The one place the generic server meets the beauty advisor. */
const WIRING = "server/main.ts";
const BROWSER_LAYERS = ["protocol", "client", "web"];

function sourceFiles(layer: string) {
  return readdirSync(resolve(SRC, layer), { recursive: true })
    .map(String)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => resolve(SRC, layer, name));
}

function specifiers(file: string) {
  const text = readFileSync(file, "utf8");
  return [
    ...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g),
  ].map((match) => match[1]);
}

describe("layering", () => {
  it("lets each layer import only the layers beneath it", () => {
    const violations: string[] = [];
    for (const [layer, allowed] of Object.entries(ALLOWED)) {
      for (const file of sourceFiles(layer)) {
        const name = relative(SRC, file).split(sep).join("/");
        for (const spec of specifiers(file)) {
          if (!spec.startsWith(".")) continue;
          const target = relative(SRC, resolve(dirname(file), spec));
          const other = target.split(sep)[0];
          if (other === layer || allowed.includes(other)) continue;
          if (name === WIRING && other === "advisor") continue;
          violations.push(`${name} imports ${spec}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it("keeps Node-only modules out of what the browser bundles", () => {
    const offenders: string[] = [];
    for (const layer of BROWSER_LAYERS) {
      for (const file of sourceFiles(layer)) {
        for (const spec of specifiers(file))
          if (spec.startsWith("node:") || spec === "sharp")
            offenders.push(`${relative(SRC, file)} imports ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
