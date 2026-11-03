import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import "./helpers.ts";
import { testServer, type TestServer } from "./harness.ts";

// The MCP endpoint, exercised with the official MCP client over the app's own
// fetch (no sockets). Both protocol eras must work from the same endpoint.

async function connect(
  t: TestServer,
  token: string,
  mode: "legacy" | "modern",
) {
  const client = new Client(
    { name: "test-agent", version: "1.0.0" },
    mode === "modern" ? { versionNegotiation: { mode: "auto" } } : {},
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://app.test/mcp"),
    {
      authProvider: { token: async () => token },
      fetch: async (input, init) =>
        t.app.request(new Request(input as string | URL, init)),
    },
  );
  await client.connect(transport);
  // Prove each run really spoke the era it claims, not a silent fallback.
  assert.equal(client.getProtocolEra(), mode);
  return client;
}

type Text = {
  content: { type: string; text: string }[];
  isError?: boolean;
  structuredContent?: any;
};

const payload = (result: Text) => JSON.parse(result.content[0].text) as any;

for (const mode of ["modern", "legacy"] as const) {
  describe(`MCP (${mode} protocol)`, () => {
    it("lists every tool with its JSON Schema", async () => {
      const t = testServer();
      const s = await t.readySession();
      const client = await connect(t, s.agent, mode);
      try {
        const { tools } = await client.listTools();
        const names = tools.map((tool) => tool.name);
        assert.equal(names.length, 18);
        assert.ok(
          names.includes("wait_for_events") && names.includes("analyze_skin"),
        );
        const skin = tools.find((tool) => tool.name === "analyze_skin")!;
        assert.equal((skin.inputSchema as any).type, "object");
        assert.deepEqual(
          Object.keys((skin.inputSchema as any).properties).sort(),
          ["concerns", "photo_id"],
        );
        assert.equal(skin.annotations?.readOnlyHint, false);
        const state = tools.find((tool) => tool.name === "get_session_state")!;
        assert.equal(state.annotations?.readOnlyHint, true);
      } finally {
        await client.close();
      }
    });

    it("runs a consult through tools, bound to the token's session", async () => {
      const t = testServer();
      const s = await t.readySession();
      const client = await connect(t, s.agent, mode);
      try {
        const skin = payload(
          (await client.callTool({
            name: "analyze_skin",
            arguments: {},
          })) as Text,
        );
        assert.equal(skin.ok, true);
        assert.equal(skin.units, 12);
        const shown = payload(
          (await client.callTool({
            name: "ui_show",
            arguments: { target: "skin:pore" },
          })) as Text,
        );
        assert.equal(shown.result.target, "skin:pore");
        const said = payload(
          (await client.callTool({
            name: "say",
            arguments: { text: "Hi **there**" },
          })) as Text,
        );
        assert.equal(said.result.spoken, "Hi there.");
        const state = await s.state();
        assert.equal(state.ui.target, "skin:pore");
        assert.equal(state.messages.at(-1)?.body, "Hi there");
        assert.equal(state.budget.unitsUsed, 12);
      } finally {
        await client.close();
      }
    });

    it("reports tool refusals as errors the model can read", async () => {
      const t = testServer();
      const s = await t.newSession();
      const client = await connect(t, s.agent, mode);
      try {
        const refused = (await client.callTool({
          name: "analyze_skin",
          arguments: {},
        })) as Text;
        assert.equal(refused.isError, true);
        assert.equal(payload(refused).error.code, "consent_required");
        const invalid = (await client.callTool({
          name: "analyze_skin",
          arguments: { concerns: ["nope"] },
        })) as Text;
        assert.equal(invalid.isError, true);
        assert.equal(payload(invalid).error.code, "invalid_arguments");
      } finally {
        await client.close();
      }
    });

    it("listens for the client with wait_for_events", async () => {
      const t = testServer();
      const s = await t.newSession();
      const client = await connect(t, s.agent, mode);
      try {
        const rev = (await s.state()).rev;
        const waiting = client.callTool({
          name: "wait_for_events",
          arguments: {
            after_rev: rev,
            timeout_seconds: 5,
            types: ["message.created"],
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        await s.chat("hello from the client");
        const events = payload((await waiting) as Text).result.events;
        assert.equal(events.length, 1);
        assert.equal(events[0].data.message.body, "hello from the client");
      } finally {
        await client.close();
      }
    });

    it("offers the advisor instructions as a prompt", async () => {
      const t = testServer();
      const s = await t.newSession({ advisor: { name: "Mara" } });
      const client = await connect(t, s.agent, mode);
      try {
        const { prompts } = await client.listPrompts();
        assert.deepEqual(
          prompts.map((prompt) => prompt.name),
          ["advisor_instructions"],
        );
        const prompt = await client.getPrompt({ name: "advisor_instructions" });
        const text = (prompt.messages[0].content as { text: string }).text;
        assert.match(text, /You are Mara/);
        assert.match(text, /Never diagnose/);
      } finally {
        await client.close();
      }
    });
  });
}

describe("MCP access", () => {
  const post = (t: TestServer, token?: string) =>
    t.app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

  it("requires the advisor's token: nothing else opens the tools", async () => {
    const t = testServer();
    const s = await t.newSession();
    for (const token of [undefined, "garbage", s.client]) {
      const response = await post(t, token);
      assert.equal(response.status, 401, String(token));
      assert.match(response.headers.get("www-authenticate") ?? "", /Bearer/);
    }
    const host = await post(t, "host_key_for_tests_0123456789abcdef");
    assert.equal(host.status, 401, "a host key is not an advisor");
  });

  it("stops serving a session once it has expired", async () => {
    const t = testServer({}, { t: 1_000_000_000_000 });
    const s = await t.newSession({ minutes: 1 });
    t.clock.t += 61_000;
    t.runtime.sweep();
    t.clock.t += 11 * 60_000;
    t.runtime.sweep();
    const response = await post(t, s.agent);
    assert.ok([401, 404].includes(response.status));
  });

  it("is absent when switched off", async () => {
    const t = testServer({ mcp: false });
    const s = await t.newSession();
    const response = await post(t, s.agent);
    assert.equal(response.status, 404);
    const manifest = await t.data<any>("GET", "/.well-known/ppro-app.json");
    assert.equal(manifest.endpoints.mcp, null);
  });
});
