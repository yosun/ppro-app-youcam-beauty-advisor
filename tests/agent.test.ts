import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./helpers.ts";
import { makePhoto } from "./helpers.ts";
import { HOST_KEY, testServer } from "./harness.ts";
import {
  AdvisorClient,
  HostClient,
  PproError,
  type BeautyAdvisorClient,
} from "../src/client/index.ts";
import {
  runLlmAdvisor,
  type Model,
  type ModelReply,
  type Turn,
} from "../examples/llm-agent.ts";
import { depthOf, runScriptedAdvisor } from "../examples/scripted-agent.ts";

// An external agent, written against the SDK alone, runs a whole consult with
// a client played by another SDK instance. Nothing reaches into the server.

function clients(t: ReturnType<typeof testServer>) {
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) =>
    t.app.request(new Request(input as string | URL, init))) as typeof fetch;
  return { fetcher, baseUrl: "http://app.test" };
}

describe("a scripted external agent", () => {
  it("runs a consult end to end through the SDK", async () => {
    const t = testServer();
    const { fetcher, baseUrl } = clients(t);
    const host = new HostClient({ baseUrl, hostKey: HOST_KEY, fetch: fetcher });
    const created = await host.createSession({
      advisor: { name: "Aria" },
      client: { display_name: "Ada" },
    });
    const advisor = host.advisor(created, fetcher);
    const client = new AdvisorClient({
      baseUrl,
      token: created.tokens.client,
      sessionId: created.session.id,
      fetch: fetcher,
    }) as BeautyAdvisorClient;

    const log: string[] = [];
    const running = runScriptedAdvisor(advisor, {
      log: (line) => log.push(line),
    });

    // The advisor greets and asks for a selfie.
    await waitFor(async () => (await client.state()).ui.mediaRequest !== null);
    let state = await client.state();
    assert.match(state.messages[0].body, /I'm Aria/);
    assert.equal(state.messages[0].role, "agent");

    // The client consents and shares a photo; the advisor does the rest.
    await client.consent({ adult: true, photoAnalysis: true });
    await client.uploadPhoto(new Uint8Array(await makePhoto(900, 1200)));
    await waitFor(
      async () =>
        (await client.state()).app.card !== null &&
        (await client.state()).presence === "idle",
    );
    state = await client.state();
    assert.deepEqual(state.ui.available, [
      "chat",
      "skin",
      "face",
      "look",
      "steps",
      "shades",
    ]);
    assert.equal(state.ui.screen, "look", "the advisor ended on the look");
    assert.equal(state.ui.view.compare, 0, "and revealed the whole try-on");
    assert.equal(state.ui.mediaRequest, null);
    assert.equal(state.app.skin?.scores.length, 8);
    assert.equal(state.app.card?.shades.length, 3);
    assert.equal(state.app.card?.before?.id, state.photos[0].id);
    assert.equal(state.budget.unitsUsed, 12 + 10 + 20 + 1);
    const said = state.messages
      .filter((m) => m.role === "agent")
      .map((m) => m.body);
    assert.ok(
      said.some((text) =>
        /needs? the most care|could use the most care/.test(text),
      ),
    );
    assert.ok(
      said.some((text) => /demo preview/i.test(text)),
      "it discloses simulated results",
    );

    // The client asks for a color and then says goodbye.
    await client.clientMessage("Can you try berry on me?");
    await waitFor(async () => (await client.state()).app.tryOns.length === 2);
    assert.equal(
      (await client.state()).app.tryOns[1].swatches[0].color,
      "#8E2C48",
    );
    await client.clientMessage("thanks, bye!");
    await running;
    state = await client.state();
    assert.equal(state.phase, "ended");
    assert.equal(state.endReason, "agent");
    assert.equal(state.photos.length, 0, "the photo is gone");
    assert.ok(log.some((line) => line.startsWith("Aria:")));
  });

  it("asks for a retake when YouCam says the photo is unusable", async () => {
    process.env.YOUCAM_API_KEY = "test-key-not-real";
    const { fakeYouCam } = await import("./helpers.ts");
    const api = fakeYouCam({
      taskError: "error_src_face_too_small",
      resultImage: await makePhoto(400, 500, "png"),
    });
    try {
      const t = testServer();
      const { fetcher, baseUrl } = clients(t);
      const host = new HostClient({
        baseUrl,
        hostKey: HOST_KEY,
        fetch: fetcher,
      });
      const created = await host.createSession({
        consent: { adult: true, photo_analysis: true },
      });
      const advisor = host.advisor(created, fetcher);
      const client = new AdvisorClient({
        baseUrl,
        token: created.tokens.client,
        sessionId: created.session.id,
        fetch: fetcher,
      }) as BeautyAdvisorClient;
      const running = runScriptedAdvisor(advisor);
      await waitFor(async () => (await client.state()).messageCount >= 1);
      await client.uploadPhoto(new Uint8Array(await makePhoto(900, 1200)));
      await waitFor(async () =>
        (await client.state()).messages.some(
          (m) => /Move closer/.test(m.body) && m.role === "agent",
        ),
      );
      const state = await client.state();
      assert.ok(state.ui.mediaRequest, "it asks again");
      assert.equal(state.budget.unitsUsed, 0);
      await client.end();
      await running;
    } finally {
      api.restore();
      delete process.env.YOUCAM_API_KEY;
    }
  });
});

describe("the SDK", () => {
  it("raises typed errors with the server's code and retry hint", async () => {
    const t = testServer();
    const { fetcher, baseUrl } = clients(t);
    const bad = new AdvisorClient({ baseUrl, token: "nope", fetch: fetcher });
    await assert.rejects(
      () => bad.state(),
      (error: PproError) =>
        error.status === 401 && error.code === "unauthorized",
    );
    const host = new HostClient({ baseUrl, hostKey: HOST_KEY, fetch: fetcher });
    const created = await host.createSession();
    const advisor = host.advisor(created, fetcher);
    await assert.rejects(
      () => advisor.tool("analyze_skin", { concerns: ["nope"] }),
      (error: PproError) =>
        error.status === 422 && error.code === "invalid_arguments",
    );
    const refused = await advisor.tool("analyze_skin");
    assert.equal(refused.ok, false, "a refusal is a result, not an exception");
  });

  it("reads the manifest, instructions and tools in each framework's format", async () => {
    const t = testServer();
    const { fetcher, baseUrl } = clients(t);
    const host = new HostClient({ baseUrl, hostKey: HOST_KEY, fetch: fetcher });
    const created = await host.createSession({ advisor: { name: "Aria" } });
    const advisor = host.advisor(created, fetcher);
    assert.equal((await advisor.manifest()).protocol, "ppro-app/1");
    assert.match(await advisor.instructions(), /You are Aria/);
    assert.equal((await advisor.tools("gemini")).length, 1);
    assert.equal((await advisor.tools("openai")).length, 18);
  });

  it("streams events with resume, and stops at the end of the session", async () => {
    const t = testServer();
    const { fetcher, baseUrl } = clients(t);
    const host = new HostClient({ baseUrl, hostKey: HOST_KEY, fetch: fetcher });
    const created = await host.createSession();
    const advisor = host.advisor(created, fetcher);
    const client = new AdvisorClient({
      baseUrl,
      token: created.tokens.client,
      sessionId: created.session.id,
      fetch: fetcher,
    }) as BeautyAdvisorClient;
    const seen: string[] = [];
    const reading = (async () => {
      for await (const event of advisor.events({ after: 0 }))
        seen.push(event.type);
    })();
    await client.clientMessage("hello");
    await client.end();
    await reading;
    assert.deepEqual(seen, [
      "session.started",
      "message.created",
      "session.ended",
    ]);
  });

  it("lets a host mint a client link again", async () => {
    const t = testServer();
    const { fetcher, baseUrl } = clients(t);
    const host = new HostClient({ baseUrl, hostKey: HOST_KEY, fetch: fetcher });
    const created = await host.createSession();
    const minted = await host.mintToken(created.session.id, "client");
    assert.match(minted.url ?? "", /#t=p1\./);
  });
});

describe("an LLM-driven advisor", () => {
  /** A model that decides from a script, so the loop around it can be tested. */
  function scripted(
    steps: Array<
      (seen: { system: string; turns: Turn[]; tools: unknown[] }) => ModelReply
    >,
  ): Model & { calls: number } {
    const model = {
      calls: 0,
      toolFormat: "gemini" as const,
      async step(input: { system: string; turns: Turn[]; tools: unknown[] }) {
        const next =
          steps[model.calls++] ?? (() => ({ text: "(out of script)" }));
        return next(input);
      },
    };
    return model;
  }

  it("runs the loop: briefing, tool calls with refusals fed back, then a reply", async () => {
    const t = testServer();
    const { fetcher, baseUrl } = clients(t);
    const host = new HostClient({ baseUrl, hostKey: HOST_KEY, fetch: fetcher });
    const created = await host.createSession({ advisor: { name: "Aria" } });
    const advisor = host.advisor(created, fetcher);
    const client = new AdvisorClient({
      baseUrl,
      token: created.tokens.client,
      sessionId: created.session.id,
      fetch: fetcher,
    }) as BeautyAdvisorClient;

    const seen: { system: string; toolNames: string[]; lastTool?: unknown }[] =
      [];
    const model = scripted([
      // Step 1: it tries to analyze before there is any photo or consent.
      (input) => {
        seen.push({ system: input.system, toolNames: toolNames(input.tools) });
        return { calls: [{ name: "analyze_skin", args: {} }] };
      },
      // Step 2: it sees the refusal as data and asks for a selfie instead.
      (input) => {
        const last = input.turns.at(-1) as Extract<Turn, { role: "tool" }>;
        seen.push({
          system: input.system,
          toolNames: [],
          lastTool: last.results[0].result,
        });
        return {
          calls: [
            {
              name: "ui_request_photo",
              args: { reason: "I need a photo first." },
            },
          ],
        };
      },
      // Step 3: it also sends a malformed call; the 422 message reaches the model.
      () => ({
        calls: [{ name: "analyze_skin", args: { concerns: ["nope"] } }],
      }),
      (input) => {
        const last = input.turns.at(-1) as Extract<Turn, { role: "tool" }>;
        seen.push({
          system: "",
          toolNames: [],
          lastTool: last.results[0].result,
        });
        return {
          text: "Could you share a selfie so I can measure instead of guess?",
        };
      },
    ]);

    const controller = new AbortController();
    const running = runLlmAdvisor(advisor, model, {
      signal: controller.signal,
    });
    await client.clientMessage("Can you look at my skin?");
    await waitFor(async () =>
      (await client.state()).messages.some((m) => m.role === "agent"),
    );
    controller.abort();
    await running.catch(() => undefined);

    // The briefing named the advisor and the rules; the tools came in Gemini's format.
    assert.match(seen[0].system, /You are Aria/);
    assert.match(seen[0].system, /Never diagnose/);
    assert.equal(seen[0].toolNames.length, 18);
    assert.ok(
      seen[0].toolNames.includes("analyze_skin") &&
        seen[0].toolNames.includes("say"),
    );
    // The refusal was handed back as data the model could read.
    assert.equal((seen[1].lastTool as { ok: boolean }).ok, false);
    assert.equal(
      (seen[1].lastTool as { error: { code: string } }).error.code,
      "consent_required",
    );
    // The malformed call came back as an error message naming the argument.
    const bad = seen[2].lastTool as {
      ok: boolean;
      error: { code: string; message: string };
    };
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "invalid_arguments");
    assert.match(bad.error.message, /concerns/);
    // And the app did what the model asked: it is asking for a photo, and it replied.
    const state = await client.state();
    assert.equal(state.ui.mediaRequest?.reason, "I need a photo first.");
    assert.equal(
      state.messages.filter((m) => m.role === "agent").at(-1)?.body,
      "Could you share a selfie so I can measure instead of guess?",
    );
    assert.equal(state.presence, "idle");
  });

  it("stops after a bounded number of tool rounds and still answers the next message", async () => {
    const t = testServer();
    const { fetcher, baseUrl } = clients(t);
    const host = new HostClient({ baseUrl, hostKey: HOST_KEY, fetch: fetcher });
    const created = await host.createSession();
    const advisor = host.advisor(created, fetcher);
    const client = new AdvisorClient({
      baseUrl,
      token: created.tokens.client,
      sessionId: created.session.id,
      fetch: fetcher,
    }) as BeautyAdvisorClient;
    let calls = 0;
    const model: Model = {
      toolFormat: "gemini",
      async step() {
        calls++;
        // Never stops calling a tool.
        return calls <= 20
          ? { calls: [{ name: "ui_notice", args: { text: `n${calls}` } }] }
          : { text: "done" };
      },
    };
    const controller = new AbortController();
    const running = runLlmAdvisor(advisor, model, {
      signal: controller.signal,
    });
    await client.clientMessage("hello");
    await waitFor(async () => calls >= 6);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls, 6, "one client message gets at most six rounds");
    assert.equal(
      (await client.state()).presence,
      "idle",
      "and the advisor is not left 'thinking'",
    );
    controller.abort();
    await running.catch(() => undefined);
  });
});

describe("skin tone depth", () => {
  it("sorts colors into light, medium and deep", () => {
    assert.equal(depthOf("#F1D6C0"), "light");
    assert.equal(depthOf("#C99B7A"), "medium");
    assert.equal(depthOf("#4A2C1E"), "deep");
    assert.equal(depthOf(null), "medium");
  });
});

/** The names in a tool list, whichever format it is in. */
function toolNames(tools: unknown[]): string[] {
  const first = tools[0] as { functionDeclarations?: { name: string }[] };
  return (first.functionDeclarations ?? (tools as { name: string }[])).map(
    (tool) => tool.name,
  );
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the condition.");
}
