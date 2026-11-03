import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import "./helpers.ts";
import { fakeYouCam, makePhoto, stubFetch } from "./helpers.ts";
import { testServer, type TestServer } from "./harness.ts";
import {
  resetYouCamLookCache,
  YOUCAM_API_ORIGIN,
} from "../src/advisor/youcam.ts";
import { resetYouCamTasks } from "../src/advisor/limits.ts";
import { sniffImage } from "../src/support/image.ts";

// The same tools as the simulated tests, but with a key configured, so they
// take the live path: upload, task, poll, download the result.

const SKIN_OUTPUT = [
  {
    type: "acne",
    ui_score: 81.4,
    raw_score: 70,
    mask_urls: ["https://r.s3.amazonaws.com/acne.png"],
  },
  {
    type: "pore",
    ui_score: 48,
    mask_urls: ["https://r.s3.amazonaws.com/pore.png"],
  },
  { type: "moisture", ui_score: 66 },
  { type: "skin_type", skin_type: "oily", ui_score: 0 },
  { type: "age", ui_score: 37 },
  { type: "mystery", ui_score: 12 },
];

const FACE = {
  faceshape: "Heart",
  lipshape: "Full",
  eyelid: {
    left_shape: "Almond",
    right_shape: "Almond",
    left_eyelid: "Double",
    right_eyelid: "Double",
  },
  eyebrow: { left_shape: "Soft Angled", right_shape: "Soft Angled" },
  cheekbone: { overrall: "High Cheekbone" },
};

const TONE = {
  color: {
    skin_color: "#c99b7a",
    eye_color: "#4b3621",
    eye_color_name: "Brown",
    lip_color: "#b5656b",
  },
};

describe("live YouCam path", () => {
  let t: TestServer;
  let result: Buffer;

  beforeEach(async () => {
    process.env.YOUCAM_API_KEY = "test-key-not-real";
    resetYouCamLookCache();
    resetYouCamTasks();
    t = testServer();
    result = await makePhoto(640, 800, "png");
  });
  afterEach(() => {
    delete process.env.YOUCAM_API_KEY;
    delete process.env.YOUCAM_DAILY_TASK_CAP;
    resetYouCamTasks();
  });

  it("scores skin from YouCam's output, stores overlays and drops what it should", async () => {
    const api = fakeYouCam({ skin: SKIN_OUTPUT, resultImage: result });
    try {
      const s = await t.readySession();
      assert.equal((await s.state()).engine.mode, "live");
      const out = await s.tool("analyze_skin", {
        concerns: ["acne", "pore", "moisture", "skin_type"],
      });
      assert.ok(out.ok, JSON.stringify(out));
      const scores = out.result.scores as {
        label: string;
        score: number;
        target: string;
      }[];
      assert.deepEqual(
        scores.map((item) => [item.label, item.score]),
        [
          ["Pores", 48],
          ["Hydration", 66],
          ["Acne", 81],
        ],
        "sorted so what needs care comes first; rounded",
      );
      assert.equal(out.result.skin_type, "oily");
      assert.equal(out.result.simulated, false);
      assert.deepEqual(out.result.needs_most_care, [
        "Pores",
        "Hydration",
        "Acne",
      ]);
      assert.ok(
        !JSON.stringify(out).includes("Age"),
        "unknown and sensitive types never appear",
      );
      const report = (await s.state()).app.skin!;
      assert.equal(report.simulated, false);
      assert.equal(
        report.images.length,
        2,
        "an overlay per scored concern that had one",
      );
      const acne = report.scores.find((score) => score.concern === "acne")!;
      assert.ok(acne.imageId);
      const overlay = await t.call("GET", `${s.base}/images/${acne.imageId}`, {
        token: s.client,
      });
      assert.equal(overlay.status, 200);
      assert.equal(
        sniffImage(new Uint8Array(await overlay.arrayBuffer()))?.format,
        "jpeg",
        "re-encoded",
      );
      const task = api.calls.find(
        (call) =>
          call.method === "POST" &&
          call.url.pathname.endsWith("/skin-analysis"),
      )!;
      const sent = JSON.parse(task.body);
      assert.deepEqual(sent.dst_actions, [
        "acne",
        "pore",
        "moisture",
        "skin_type",
      ]);
      assert.equal(sent.src_file_id, "file-1");
      assert.ok(task.headers.get("authorization")?.startsWith("Bearer "));
    } finally {
      api.restore();
    }
  });

  it("uploads the photo once and reuses the file for the next tools", async () => {
    const api = fakeYouCam({
      skin: SKIN_OUTPUT,
      face: FACE,
      tone: TONE,
      resultImage: result,
    });
    try {
      const s = await t.readySession();
      await s.tool("analyze_skin");
      await s.tool("analyze_face");
      await s.tool("analyze_skin_tone");
      const uploads = api.calls.filter(
        (call) => call.url.pathname === "/s2s/v2.0/file",
      );
      assert.equal(uploads.length, 1);
    } finally {
      api.restore();
    }
  });

  it("scales a large photo to 1024 px before it reaches YouCam", async () => {
    const api = fakeYouCam({ tone: TONE, resultImage: result });
    try {
      const s = await t.readySession();
      // The session stores up to 2048 px; YouCam must get at most 1024.
      const { photo } = await s.photo(2000, 2600);
      assert.equal(photo.height, 2048);
      const out = await s.tool("analyze_skin_tone", { photo_id: photo.id });
      assert.ok(out.ok, JSON.stringify(out));
      const put = api.calls.find((call) => call.method === "PUT")!;
      const sent = sniffImage(put.bytes)!;
      assert.equal(sent.format, "jpeg");
      assert.equal(Math.max(sent.width, sent.height), 1024);
      const declared = JSON.parse(api.calls[0].body).files[0].file_size;
      assert.equal(
        declared,
        put.bytes.byteLength,
        "the declared size is the size actually sent",
      );
    } finally {
      api.restore();
    }
  });

  it("reads face and color results and remembers the measurements", async () => {
    const api = fakeYouCam({ face: FACE, tone: TONE, resultImage: result });
    try {
      const s = await t.readySession();
      const face = await s.tool("analyze_face", {
        features: ["faceShape", "lipShape"],
      });
      assert.ok(face.ok);
      const names = face.result.attributes as {
        name: string;
        value: string;
        target: string;
      }[];
      assert.deepEqual(
        names.slice(0, 2).map((a) => [a.name, a.value, a.target]),
        [
          ["Face shape", "Heart", "face:0"],
          ["Eye shape", "Almond", "face:1"],
        ],
      );
      const tone = await s.tool("analyze_skin_tone");
      const colors = tone.result.attributes as {
        name: string;
        value: string;
        color?: string;
        target: string;
      }[];
      assert.deepEqual(colors[0], {
        name: "Skin tone",
        value: "#C99B7A",
        color: "#C99B7A",
        target: "tone:0",
      });
      assert.equal(colors[1].value, "Brown");
      const state = await s.state();
      assert.equal(state.app.measurements.faceShape, "Heart");
      assert.equal(state.app.measurements.skinColor, "#C99B7A");
      const sent = JSON.parse(
        api.calls.find(
          (c) =>
            c.url.pathname.endsWith("/face-attr-analysis") &&
            c.method === "POST",
        )!.body,
      );
      assert.deepEqual(sent.features, ["faceShape", "lipShape"]);
    } finally {
      api.restore();
    }
  });

  it("uses the measured colors and face shape to build a full look", async () => {
    const api = fakeYouCam({ face: FACE, tone: TONE, resultImage: result });
    try {
      const s = await t.readySession();
      await s.tool("analyze_face");
      await s.tool("analyze_skin_tone");
      const out = await s.tool("try_on_full_look", {
        look: {
          name: "Sculpt",
          intensity: "medium",
          contour: true,
          highlight: true,
          lip: { color: "#C9677B", finish: "gloss" },
        },
      });
      assert.ok(out.ok, JSON.stringify(out));
      const task = api.calls
        .filter(
          (c) => c.method === "POST" && c.url.pathname.endsWith("/makeup-vto"),
        )
        .at(-1)!;
      const effects = JSON.parse(task.body).effects as {
        category: string;
        pattern?: { name: string };
      }[];
      const categories = effects.map((e) => e.category);
      assert.deepEqual(
        categories.sort(),
        ["contour", "highlighter", "lip_color", "skin_smooth"].sort(),
      );
      assert.equal(
        effects.find((e) => e.category === "contour")!.pattern!.name,
        "HeartFace2",
        "placed for a heart face",
      );
      assert.equal(
        effects.find((e) => e.category === "highlighter")!.pattern!.name,
        "HeartFace4",
      );
      const stored = (await s.state()).app.tryOns.at(-1)!;
      assert.equal(stored.kind, "full_face");
      assert.equal(stored.simulated, false);
      const image = await t.call("GET", `${s.base}/images/${stored.imageId}`, {
        token: s.client,
      });
      assert.equal(image.status, 200);
    } finally {
      api.restore();
    }
  });

  it("applies curated looks from YouCam's catalog and refuses ids outside it", async () => {
    const api = fakeYouCam({
      resultImage: result,
      looks: [
        { id: "look_pure", title: "Pure", category_name: "Daily" },
        { id: "look_gala", title: "Gala", category_name: "Red Carpet" },
      ],
    });
    try {
      const s = await t.readySession();
      const listed = await s.tool("list_makeup_looks", {
        category: "Red Carpet",
      });
      assert.deepEqual(listed.result.looks, [
        { id: "look_gala", title: "Gala", category: "Red Carpet" },
      ]);
      const wrong = await s.tool("try_on_look", { look_id: "look_nowhere" });
      assert.equal(wrong.error?.code, "unknown_look");
      const ok = await s.tool("try_on_look", { look_id: "look_pure" });
      assert.ok(ok.ok);
      assert.equal(ok.units, 2);
      const sent = JSON.parse(
        api.calls.find(
          (c) => c.method === "POST" && c.url.pathname.endsWith("/look-vto"),
        )!.body,
      );
      assert.equal(sent.template_id, "look_pure");
    } finally {
      api.restore();
    }
  });

  it("turns a rejected photo into retake guidance, costing nothing", async () => {
    const api = fakeYouCam({
      taskError: "error_src_face_too_small",
      resultImage: result,
    });
    try {
      const s = await t.readySession();
      const out = await s.tool("analyze_skin");
      assert.equal(out.ok, false);
      assert.equal(out.error?.code, "photo_problem");
      assert.equal(out.error?.detail, "error_src_face_too_small");
      assert.match(out.error!.message, /Move closer/);
      assert.equal(out.units, 0);
      const state = await s.state();
      assert.equal(state.budget.unitsUsed, 0);
      const notice = state.messages.find((m) => m.kind === "notice");
      assert.match(
        notice?.body ?? "",
        /Move closer/,
        "the client sees the guidance too",
      );
    } finally {
      api.restore();
    }
  });

  it("reports an outage as retryable and not as a photo problem", async () => {
    const api = stubFetch(({ url }) =>
      url.hostname === new URL(YOUCAM_API_ORIGIN).hostname
        ? Response.json({ error: "overloaded" }, { status: 503 })
        : null,
    );
    try {
      const s = await t.readySession();
      const out = await s.tool("analyze_face");
      assert.equal(out.ok, false);
      assert.notEqual(out.error?.code, "photo_problem");
      assert.equal(out.error?.retryable, true);
    } finally {
      api.restore();
    }
  });

  it("stops at the server-wide daily cap and gives unused tasks back", async () => {
    process.env.YOUCAM_DAILY_TASK_CAP = "2";
    const api = fakeYouCam({ face: FACE, tone: TONE, resultImage: result });
    try {
      const s = await t.readySession();
      assert.ok((await s.tool("analyze_face")).ok);
      assert.ok((await s.tool("analyze_skin_tone")).ok);
      const third = await s.tool("analyze_face");
      assert.equal(third.ok, false);
      assert.equal(third.error?.code, "daily_limit");
      assert.equal(
        (await s.state()).budget.unitsUsed,
        30,
        "the refused call cost nothing",
      );
    } finally {
      api.restore();
    }
  });

  it("is unavailable, not simulated, when switched off", async () => {
    process.env.YOUCAM_ENABLED = "false";
    try {
      const s = await t.readySession();
      assert.equal((await s.state()).engine.mode, "unavailable");
      const out = await s.tool("analyze_skin");
      assert.equal(out.ok, false);
      assert.equal(out.error?.code, "unavailable");
      assert.ok(
        (
          await s.tool("recommend_products", {
            products: [
              {
                category: "serum",
                brand: "B",
                name: "N",
                shade: "",
                why: "Because.",
                tier: "drugstore",
              },
            ],
          })
        ).ok,
        "tools that need no YouCam still work",
      );
      assert.match(
        (await t.data<any>("GET", `${s.base}/instructions`, { token: s.agent }))
          .text,
        /unavailable right now/,
      );
    } finally {
      delete process.env.YOUCAM_ENABLED;
    }
  });

  it("does not keep a session's images when the session ends mid-call", async () => {
    const slow = fakeYouCam({ skin: SKIN_OUTPUT, resultImage: result });
    const original = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = new Request(input as string | URL, init);
      if (request.method === "PUT") await gate;
      return original(input, init);
    }) as typeof fetch;
    try {
      const s = await t.readySession();
      const pending = s.tool("analyze_skin");
      await new Promise((resolve) => setTimeout(resolve, 30));
      t.runtime.end(t.runtime.get(s.id), "client", "client");
      release();
      const out = await pending;
      assert.equal(out.ok, false);
      assert.equal(out.error?.code, "session_ended");
      assert.equal(t.runtime.get(s.id).images.size, 0);
      assert.equal(t.runtime.get(s.id).unitsUsed, 0);
    } finally {
      globalThis.fetch = original;
      slow.restore();
    }
  });
});
