import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./helpers.ts";
import { testServer } from "./harness.ts";
import { applyEvent, isNext } from "../src/web/apply-event.ts";

// The web app's view of a session is a snapshot plus events. This proves that
// applying every event to the first snapshot gives the same session the server
// reports at the end, whatever the agent and the client did in between.

describe("applyEvent", () => {
  it("rebuilds the server's session exactly from the snapshot and its events", async () => {
    const t = testServer();
    const s = await t.newSession({ advisor: { name: "Aria" } });
    let mine = await s.state(s.client);
    const start = mine.rev;

    // A full consult with everything the app can show.
    await s.consent();
    const { photo } = await s.photo();
    await s.chat("hello");
    await s.tool("ui_request_photo", { reason: "A selfie please" });
    await s.tool("analyze_skin");
    await s.tool("analyze_face");
    await s.tool("analyze_skin_tone");
    await s.tool("set_presence", { state: "thinking" });
    const tryOn = await s.tool("try_on_full_look", {
      look: { name: "Rose", intensity: "soft", lip: { color: "#C9677B" } },
    });
    await s.tool("recommend_products", {
      products: [
        {
          category: "serum",
          brand: "B",
          name: "N",
          shade: "",
          why: "Because.",
          tier: "mid-range",
        },
      ],
    });
    await s.tool("present_look", {
      title: "Rose",
      steps: ["One.", "Two."],
      shades: [{ label: "Rose", hex: "#C9677B", area: "lips" }],
      image_id: tryOn.result.image_id,
      before_photo_id: photo.id,
    });
    await s.tool("ui_show", { target: "step:1" });
    await s.tool("ui_compare", { reveal: 30 });
    await s.tool("ui_notice", { text: "Nice light.", tone: "info" });
    await s.say("Here is your look.");
    await t.data("POST", `${s.base}/ui-events`, {
      token: s.client,
      json: { type: "navigate", screen: "skin" },
    });
    await t.data("POST", `${s.base}/ui-events`, {
      token: s.client,
      json: { type: "view", view: { compare: 20 } },
    });
    await t.data("POST", `${s.base}/ui-events`, {
      token: s.client,
      json: { type: "dismiss", what: "notice" },
    });
    await t.call("DELETE", `${s.base}/photos/${photo.id}`, { token: s.client });
    await s.tool("analyze_face");

    // Replay: start from the snapshot taken at `start`, apply all events.
    const { events } = await s.events(start);
    let rebuilt = { ...mine };
    for (const event of events) {
      assert.ok(
        isNext(rebuilt, event),
        `event ${event.rev} follows ${rebuilt.rev}`,
      );
      rebuilt = applyEvent(rebuilt, event);
    }
    const actual = await s.state(s.client);
    assert.equal(rebuilt.rev, actual.rev);
    assert.deepEqual(rebuilt.messages, actual.messages);
    assert.deepEqual(rebuilt.photos, actual.photos);
    assert.deepEqual(rebuilt.app, actual.app);
    assert.deepEqual(rebuilt.ui, actual.ui);
    assert.deepEqual(rebuilt.budget, actual.budget);
    assert.deepEqual(rebuilt.consent, actual.consent);
    assert.equal(rebuilt.presence, actual.presence);
    mine = rebuilt;
    assert.equal(mine.messageCount, actual.messageCount);
  });

  it("also rebuilds the end of a session", async () => {
    const t = testServer();
    const s = await t.readySession();
    await s.tool("analyze_skin");
    const first = await s.state(s.client);
    await t.call("DELETE", s.base, { token: s.client });
    const { events } = await s.events(first.rev);
    let rebuilt = first;
    for (const event of events) rebuilt = applyEvent(rebuilt, event);
    const actual = await s.state(s.client);
    assert.equal(rebuilt.phase, "ended");
    assert.equal(rebuilt.endReason, "client");
    assert.deepEqual(rebuilt.photos, actual.photos);
    assert.deepEqual(
      rebuilt.app,
      actual.app,
      "result images are dropped from the app state",
    );
  });

  it("ignores a message it already holds", async () => {
    const t = testServer();
    const s = await t.newSession();
    await s.chat("once");
    const snapshot = await s.state(s.client);
    const { events } = await s.events(0);
    const replay = events.find((e) => e.type === "message.created")!;
    const again = applyEvent(snapshot, replay);
    assert.equal(again.messages.length, snapshot.messages.length);
  });
});
