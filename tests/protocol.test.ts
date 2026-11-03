import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./helpers.ts";
import { isId, newId } from "../src/protocol/ids.ts";
import {
  cleanAgentText,
  cleanClientText,
  cleanDisplayLine,
  normalizeHex,
  speakable,
  violatesContentFloor,
} from "../src/protocol/text.ts";
import { formatTarget, splitTarget } from "../src/protocol/targets.ts";
import {
  parseTarget,
  screenOfTarget,
  targetIndex,
} from "../src/advisor/screens.ts";
import { mintToken, sameSecret, verifyToken } from "../src/server/tokens.ts";
import { Bucket, WindowCounter } from "../src/server/rate-limit.ts";

describe("ids", () => {
  it("makes unique, well-formed ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId("ses")));
    assert.equal(ids.size, 500);
    for (const id of ids) assert.match(id, /^ses_[A-Za-z0-9]{22}$/);
  });

  it("validates by kind", () => {
    assert.ok(isId(newId("pho"), "pho"));
    assert.ok(!isId(newId("pho"), "img"));
    assert.ok(!isId("pho_short"));
    assert.ok(!isId(42));
  });
});

describe("agent text hygiene", () => {
  it("removes links and markdown", () => {
    const out = cleanAgentText(
      "Try **this** at https://x.example/a?b=1 or www.y.com now",
    );
    assert.deepEqual(out, { ok: true, text: "Try this at or now" });
  });

  it("refuses empty text", () => {
    assert.deepEqual(cleanAgentText("   "), { ok: false, reason: "empty" });
    assert.deepEqual(cleanAgentText(42), { ok: false, reason: "empty" });
  });

  it("blocks sexual content and nude pictures", () => {
    assert.deepEqual(cleanAgentText("send nudes"), {
      ok: false,
      reason: "blocked",
    });
    assert.deepEqual(cleanAgentText("some porn site"), {
      ok: false,
      reason: "blocked",
    });
  });

  it("allows ordinary beauty vocabulary the old blocklist caught", () => {
    for (const text of [
      "A nude lip suits you.",
      "The naked palette has warm shades.",
      "Great for a photo shoot or a shot of color.",
      "A lip bomb keeps lips soft.",
      "Gun-metal eyeliner is striking.",
    ])
      assert.equal(cleanAgentText(text).ok, true, text);
    assert.equal(violatesContentFloor("nude lipstick"), false);
  });

  it("cuts long text at a word", () => {
    const out = cleanAgentText("word ".repeat(600), 100);
    assert.ok(out.ok);
    assert.ok(out.text.length <= 100);
    assert.ok(out.text.endsWith("…"));
  });
});

describe("client text", () => {
  it("strips control characters and caps length", () => {
    assert.equal(cleanClientText("hi\u0000 there\u0007"), "hi there");
    assert.equal(cleanClientText("a".repeat(5000)).length, 1000);
    assert.equal(cleanClientText("a\n\n\n\nb"), "a\n\nb");
  });
});

describe("display lines", () => {
  it("drops links and markdown and enforces the content floor", () => {
    assert.equal(
      cleanDisplayLine("Soft **rose** https://a.b", 50),
      "Soft rose",
    );
    assert.equal(cleanDisplayLine("send nudes", 50), "");
    assert.equal(cleanDisplayLine(42, 50), "");
    assert.equal(cleanDisplayLine("x".repeat(100), 10).length, 10);
  });
});

describe("hex colors", () => {
  it("normalizes valid colors and rejects the rest", () => {
    assert.equal(normalizeHex("c9677b"), "#C9677B");
    assert.equal(normalizeHex(" #c9677b "), "#C9677B");
    assert.equal(normalizeHex("#12345"), null);
    assert.equal(normalizeHex("red"), null);
    assert.equal(normalizeHex(null), null);
  });
});

describe("speakable", () => {
  it("turns lists and markdown into spoken sentences", () => {
    assert.equal(
      speakable("**Hello** there\n1. Cleanse\n2) Moisturize\n- Sunscreen 😀"),
      "Hello there. Cleanse. Moisturize. Sunscreen.",
    );
  });

  it("cuts at a sentence under the limit", () => {
    const out = speakable("First sentence here. ".repeat(60), 120);
    assert.ok(out.length <= 120);
    assert.ok(out.endsWith("."));
  });
});

describe("targets", () => {
  it("splits any well-formed target", () => {
    assert.deepEqual(splitTarget("skin:acne"), {
      section: "skin",
      item: "acne",
    });
    assert.deepEqual(splitTarget("look"), { section: "look", item: null });
    assert.equal(splitTarget("Skin:acne"), null);
    assert.equal(splitTarget("skin:"), null);
    assert.equal(splitTarget("a b"), null);
    assert.equal(splitTarget(5), null);
    assert.equal(formatTarget("step", 2), "step:2");
    assert.equal(formatTarget("look"), "look");
  });

  it("maps this app's sections onto screens", () => {
    assert.equal(screenOfTarget("tone:1"), "face");
    assert.equal(screenOfTarget("step:0"), "steps");
    assert.equal(screenOfTarget("pick:2"), "picks");
    assert.equal(screenOfTarget("nope:1"), null);
    assert.equal(targetIndex("shade:3"), 3);
    assert.equal(targetIndex("skin:acne"), null);
    assert.equal(parseTarget("hasOwnProperty"), null);
  });
});

describe("tokens", () => {
  const secret = Buffer.from("s".repeat(40));
  const exp = Math.floor(Date.now() / 1000) + 600;

  it("round-trips and binds role and session", () => {
    const token = mintToken(secret, { sid: "ses_x", role: "agent", exp });
    assert.deepEqual(verifyToken(secret, token), {
      sid: "ses_x",
      role: "agent",
      exp,
    });
  });

  it("rejects tampering, other secrets and expiry", () => {
    const token = mintToken(secret, { sid: "ses_x", role: "client", exp });
    const [p, body, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sid: "ses_x", role: "agent", exp }),
    ).toString("base64url");
    assert.equal(verifyToken(secret, `${p}.${forged}.${sig}`), null);
    assert.equal(verifyToken(secret, `${p}.${body}.${sig}x`), null);
    assert.equal(verifyToken(Buffer.from("t".repeat(40)), token), null);
    const old = mintToken(secret, { sid: "ses_x", role: "agent", exp: 1000 });
    assert.equal(verifyToken(secret, old), null);
    assert.equal(verifyToken(secret, "garbage"), null);
    assert.equal(verifyToken(secret, ""), null);
  });

  it("compares static keys in constant time without false positives", () => {
    assert.ok(sameSecret("abc", "abc"));
    assert.ok(!sameSecret("abc", "abd"));
    assert.ok(!sameSecret("abc", "abcd"));
  });
});

describe("rate limits", () => {
  it("lets a burst through and then refills over time", () => {
    let now = 0;
    const bucket = new Bucket(3, 3000, () => now);
    assert.ok(bucket.take().ok);
    assert.ok(bucket.take().ok);
    assert.ok(bucket.take().ok);
    const blocked = bucket.take();
    assert.equal(blocked.ok, false);
    now += 1000;
    assert.ok(bucket.take().ok);
  });

  it("counts hits in a sliding window", () => {
    let now = 0;
    const counter = new WindowCounter(2, 1000, () => now);
    assert.ok(counter.hit("a"));
    assert.ok(counter.hit("a"));
    assert.ok(!counter.hit("a"));
    assert.ok(counter.hit("b"));
    now += 1001;
    assert.ok(counter.hit("a"));
  });
});
