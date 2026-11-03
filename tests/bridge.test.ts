import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./helpers.ts";
import { acceptTheme, createBridge } from "../src/web/host-bridge.ts";
import type { PproEvent } from "../src/protocol/types.ts";

// A fake window pair: enough of the browser to prove the bridge's rules.

function windows() {
  const posted: { message: unknown; target: string }[] = [];
  const parent = {
    postMessage: (message: unknown, target: string) =>
      posted.push({ message, target }),
  };
  const listeners = new Set<(event: MessageEvent) => void>();
  const win = {
    parent,
    addEventListener: (_: string, fn: (event: MessageEvent) => void) =>
      listeners.add(fn),
    removeEventListener: (_: string, fn: (event: MessageEvent) => void) =>
      listeners.delete(fn),
  } as unknown as Window;
  const deliver = (data: unknown, origin: string, source: unknown = parent) =>
    listeners.forEach((fn) =>
      fn({ data, origin, source } as unknown as MessageEvent),
    );
  return { win, parent, posted, deliver, listeners };
}

const HOST = "https://host.example";
const event = (type: string, data: unknown, rev = 5) =>
  ({ rev, at: 1, type, actor: "agent", data }) as unknown as PproEvent;

describe("host bridge", () => {
  it("does nothing outside an iframe or without a host origin", () => {
    const w = windows();
    const alone = { ...w.win, parent: undefined } as unknown as Window;
    (alone as { parent: Window }).parent = alone;
    assert.equal(createBridge(HOST, () => {}, alone).dispose(), undefined);
    assert.equal(w.listeners.size, 0);
    createBridge(null, () => {}, w.win).ready("ses_x", 1);
    assert.equal(w.posted.length, 0);
  });

  it("posts only to the exact host origin, never a wildcard", () => {
    const w = windows();
    const bridge = createBridge(HOST, () => {}, w.win);
    bridge.ready("ses_x", 3);
    bridge.event(
      event("ui.changed", {
        ui: {
          screen: "skin",
          target: "skin:pore",
          notice: { text: "private" },
        },
        by: "agent",
      }),
    );
    bridge.event(event("session.ended", { reason: "agent" }));
    assert.deepEqual(
      w.posted.map((p) => p.target),
      [HOST, HOST, HOST],
    );
    assert.ok(w.posted.every((p) => p.target !== "*"));
    assert.deepEqual(
      w.posted.map((p) => (p.message as { type: string }).type),
      ["ready", "screen", "ended"],
    );
    assert.deepEqual((w.posted[1].message as { data: unknown }).data, {
      screen: "skin",
      target: "skin:pore",
    });
  });

  it("never sends the client's private content to the host page", () => {
    const w = windows();
    const bridge = createBridge(HOST, () => {}, w.win);
    bridge.event(
      event("message.created", { message: { body: "my private question" } }),
    );
    bridge.event(event("photo.added", { photo: { id: "pho_x" } }));
    bridge.event(event("app.updated", { kind: "skin", value: {} }));
    bridge.event(
      event("ui.changed", {
        ui: { screen: "chat", target: null, notice: { text: "secret notice" } },
        by: "agent",
      }),
    );
    const sent = JSON.stringify(w.posted);
    assert.ok(!/private question|pho_x|secret notice|skin/.test(sent), sent);
  });

  it("accepts messages only from the parent window at the host origin", () => {
    const w = windows();
    const themes: string[] = [];
    createBridge(HOST, (theme) => themes.push(theme.accent), w.win);
    const good = {
      source: "ppro-host",
      v: 1,
      type: "theme",
      data: { accent: "#112233" },
    };
    w.deliver(good, "https://evil.example");
    w.deliver(good, HOST, { not: "the parent" });
    w.deliver({ ...good, v: 2 }, HOST);
    w.deliver({ ...good, source: "other" }, HOST);
    w.deliver({ ...good, type: "navigate" }, HOST);
    w.deliver({ ...good, data: { accent: "red; background:url(x)" } }, HOST);
    w.deliver("a string", HOST);
    w.deliver(null, HOST);
    assert.deepEqual(themes, []);
    w.deliver(good, HOST);
    assert.deepEqual(themes, ["#112233"]);
  });

  it("stops listening when disposed", () => {
    const w = windows();
    const bridge = createBridge(HOST, () => {}, w.win);
    assert.equal(w.listeners.size, 1);
    bridge.dispose();
    assert.equal(w.listeners.size, 0);
  });

  it("only accepts #RRGGBB colors", () => {
    assert.deepEqual(acceptTheme({ accent: "#9257ec" }), { accent: "#9257ec" });
    for (const bad of [
      "9257ec",
      "#9257e",
      "javascript:1",
      "",
      5,
      null,
      undefined,
    ])
      assert.equal(acceptTheme({ accent: bad }), null);
    assert.equal(acceptTheme(null), null);
  });
});
