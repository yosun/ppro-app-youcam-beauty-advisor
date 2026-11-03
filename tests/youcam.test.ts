import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeYouCam, makePhoto, stubFetch } from "./helpers.ts";
import {
  YouCamError,
  assertPublicHttps,
  resetYouCamLookCache,
  youcamDownloadImage,
  youcamFriendlyError,
  youcamLookTemplates,
  youcamMode,
  youcamPhotoProblem,
  youcamTask,
  youcamUploadJpeg,
} from "../src/advisor/youcam.ts";
import {
  flattenAttributes,
  isSensitiveKey,
  readFaceResults,
  readToneResults,
  simulatedFace,
  skinRating,
} from "../src/advisor/analysis.ts";
import {
  YOUCAM_SOURCE_MAX_SIDE,
  youcamSourceJpeg,
} from "../src/advisor/images.ts";
import { normalizeImage, sniffImage } from "../src/support/image.ts";
import { reserveYouCamTask, resetYouCamTasks } from "../src/advisor/limits.ts";
import { ApiError } from "../src/protocol/errors.ts";

describe("youcamMode", () => {
  afterEach(() => {
    delete process.env.YOUCAM_API_KEY;
    delete process.env.YOUCAM_ENABLED;
  });

  it("is simulated without a key, live with one, unavailable when switched off", () => {
    assert.equal(youcamMode(), "simulated");
    process.env.YOUCAM_API_KEY = "k";
    assert.equal(youcamMode(), "live");
    process.env.YOUCAM_ENABLED = "false";
    assert.equal(youcamMode(), "unavailable");
    process.env.YOUCAM_ENABLED = "true";
    assert.equal(youcamMode(), "live");
  });
});

describe("friendly errors", () => {
  it("explains photo problems and recognizes them", () => {
    assert.match(
      youcamFriendlyError("error_src_face_too_small"),
      /Move closer/,
    );
    assert.match(
      youcamFriendlyError("ERROR_LARGE_FACE_ANGLE_X"),
      /turned or tilted/,
    );
    assert.ok(youcamPhotoProblem("error_no_face"));
    assert.ok(!youcamPhotoProblem("error_server_busy"));
    assert.match(youcamFriendlyError("something_else"), /clear, front-facing/);
  });
});

describe("assertPublicHttps", () => {
  it("accepts public https hosts", () => {
    assert.equal(
      assertPublicHttps("https://bucket.s3.amazonaws.com/a.png").hostname,
      "bucket.s3.amazonaws.com",
    );
  });

  it("refuses anything that could aim a request inward", () => {
    for (const url of [
      "http://example.com/a",
      "https://127.0.0.1/a",
      "https://10.0.0.5/a",
      "https://[::1]/a",
      "https://localhost/a",
      "https://db.internal/a",
      "https://printer.local/a",
      "https://intranet/a",
      "https://user:pw@example.com/a",
      "ftp://example.com/a",
      "not a url",
    ])
      assert.throws(() => assertPublicHttps(url), YouCamError, url);
  });
});

describe("YouCam client against a fake API", () => {
  beforeEach(() => {
    process.env.YOUCAM_API_KEY = "test-key-not-real";
    resetYouCamLookCache();
  });
  afterEach(() => {
    delete process.env.YOUCAM_API_KEY;
  });

  it("uploads through the File API without forwarding Content-Length", async () => {
    const photo = await makePhoto(600, 800);
    const api = fakeYouCam({ resultImage: photo });
    try {
      const id = await youcamUploadJpeg(photo, "x.jpg");
      assert.equal(id, "file-1");
      const put = api.calls.find((call) => call.method === "PUT");
      assert.ok(put);
      assert.equal(put.headers.get("content-type"), "image/jpeg");
      // The signed headers listed Content-Length: 1. Forwarding it by hand
      // would corrupt the upload, so it must have been dropped.
      assert.equal(put.headers.get("content-length"), null);
      const declared = api.calls[0];
      assert.equal(
        (JSON.parse(declared.body) as { files: { file_size: number }[] })
          .files[0].file_size,
        photo.byteLength,
      );
      assert.equal(
        declared.headers.get("authorization"),
        "Bearer test-key-not-real",
      );
    } finally {
      api.restore();
    }
  });

  it("refuses an upload destination that points inward", async () => {
    const api = stubFetch(({ url }) =>
      url.pathname === "/s2s/v2.0/file"
        ? {
            data: {
              files: [
                {
                  file_id: "f",
                  requests: [{ url: "https://127.0.0.1/put", method: "PUT" }],
                },
              ],
            },
          }
        : null,
    );
    try {
      await assert.rejects(
        () => youcamUploadJpeg(Buffer.from("x"), "x.jpg"),
        (error: YouCamError) => error.code === "bad_url",
      );
      assert.equal(api.calls.filter((call) => call.method === "PUT").length, 0);
    } finally {
      api.restore();
    }
  });

  it("polls a task to success and reports task errors in plain words", async () => {
    const photo = await makePhoto(600, 800);
    const ok = fakeYouCam({
      resultImage: photo,
      skin: [{ type: "acne", ui_score: 80 }],
    });
    try {
      const { data } = await youcamTask(
        "skin-analysis",
        { src_file_id: "f" },
        { pollMs: 1 },
      );
      assert.equal(data.task_status, "success");
    } finally {
      ok.restore();
    }
    const bad = fakeYouCam({
      resultImage: photo,
      taskError: "error_src_face_too_small",
    });
    try {
      await assert.rejects(
        () => youcamTask("skin-analysis", { src_file_id: "f" }, { pollMs: 1 }),
        (error: YouCamError) =>
          error.code === "error_src_face_too_small" &&
          /Move closer/.test(error.message),
      );
    } finally {
      bad.restore();
    }
  });

  it("turns HTTP failures into typed errors, retryable for 5xx and 429", async () => {
    for (const [status, retryable] of [
      [401, false],
      [429, true],
      [503, true],
    ] as const) {
      const api = stubFetch(() =>
        Response.json({ error_code: "oops" }, { status }),
      );
      try {
        await assert.rejects(
          () => youcamTask("skin-analysis", {}, { pollMs: 1 }),
          (error: YouCamError) => error.retryable === retryable,
        );
      } finally {
        api.restore();
      }
    }
  });

  it("lists look templates once and caches them", async () => {
    const photo = await makePhoto(600, 800);
    const api = fakeYouCam({
      resultImage: photo,
      looks: [
        { id: "look_a", title: "A", category_name: "Daily" },
        { id: "bad id!", title: "skip me" },
      ],
    });
    try {
      const first = await youcamLookTemplates();
      const second = await youcamLookTemplates();
      assert.deepEqual(first, [
        { id: "look_a", title: "A", category: "Daily" },
      ]);
      assert.equal(second, first);
      assert.equal(api.calls.length, 1);
    } finally {
      api.restore();
    }
  });

  it("downloads results only from YouCam's storage hosts and bounds their size", async () => {
    const photo = await makePhoto(300, 400);
    const api = fakeYouCam({ resultImage: photo });
    try {
      const bytes = await youcamDownloadImage(
        "https://r.s3.amazonaws.com/x.png",
      );
      assert.ok(bytes.byteLength > 100);
      await assert.rejects(
        () => youcamDownloadImage("https://evil.example.com/x.png"),
        (error: YouCamError) => error.code === "bad_url",
      );
      await assert.rejects(
        () => youcamDownloadImage("https://r.s3.amazonaws.com/x.png", 50),
        (error: YouCamError) => error.code === "download_too_large",
      );
    } finally {
      api.restore();
    }
  });
});

describe("daily YouCam cap", () => {
  afterEach(() => {
    delete process.env.YOUCAM_DAILY_TASK_CAP;
    resetYouCamTasks();
  });

  it("stops at the cap with a 429", () => {
    process.env.YOUCAM_DAILY_TASK_CAP = "2";
    resetYouCamTasks();
    reserveYouCamTask();
    reserveYouCamTask();
    assert.throws(
      () => reserveYouCamTask(),
      (error: ApiError) => error.status === 429,
    );
  });
});

describe("result readers", () => {
  it("reads face attributes in YouCam's real layout, including its spelling slip", () => {
    const face = readFaceResults({
      results: {
        faceshape: "Heart",
        lipshape: "Full",
        eyelid: {
          left_shape: "Almond",
          right_shape: "Round",
          left_eyelid: "Double",
          right_eyelid: "Double",
          size: "Big",
          setting: "Wide",
        },
        eyebrow: {
          left_shape: "Soft Angled",
          right_shape: "Soft Angled",
          gap: "Average",
        },
        cheekbone: { overrall: "High Cheekbone" },
        nose: { width: "Narrow", length: "unknown" },
      },
    });
    assert.equal(face.faceShape, "Heart");
    assert.equal(face.eyeShape, "Almond (left), Round (right)");
    assert.equal(face.eyelid, "Double");
    assert.equal(face.browShape, "Soft Angled");
    assert.equal(face.cheekbones, "High Cheekbone");
    assert.equal(face.noseWidth, "Narrow");
    assert.ok(!("noseLength" in face), "unknown readings are dropped");
  });

  it("reads colors and normalizes hex", () => {
    const colors = readToneResults({
      color: {
        skin_color: "c99b7a",
        eye_color: "#4B3621",
        eye_color_name: "Brown",
        eyebrow_color: "not a color",
      },
    });
    assert.equal(colors.skinColor, "#C99B7A");
    assert.equal(colors.eyeColorName, "Brown");
    assert.ok(!("browColor" in colors));
  });

  it("never lets age, gender or ethnicity through, but keeps age spots", () => {
    for (const key of [
      "age",
      "gender",
      "estimated_age",
      "ethnicity",
      "attractiveness",
      "ageGender",
    ])
      assert.ok(isSensitiveKey(key), key);
    assert.ok(!isSensitiveKey("age_spot"));
    const out = flattenAttributes({
      faceshape: "Oval",
      age: 34,
      gender: "f",
      attractiveness: 91,
      image_url: "https://x.example/a.png",
      face_quality: { hasface: true },
    });
    assert.deepEqual(
      out.map((item) => item.name),
      ["Face shape"],
    );
  });

  it("rates scores in bands", () => {
    assert.equal(skinRating(90), "excellent");
    assert.equal(skinRating(70), "good");
    assert.equal(skinRating(55), "fair");
    assert.equal(skinRating(40), "needs care");
    assert.equal(skinRating(10), "needs attention");
  });

  it("simulates only the features it knows", () => {
    const sim = simulatedFace([
      "faceShape",
      "eyeColor",
      "eyebrowShape",
      "bogus",
    ]);
    assert.equal(sim.faceShape, "Oval");
    assert.equal(sim.browShape, "Soft Angled");
    assert.ok(!("bogus" in sim) && !("eyeColor" in sim));
  });
});

describe("image handling", () => {
  it("sniffs formats and dimensions from bytes alone", async () => {
    for (const format of ["jpeg", "png", "webp"] as const) {
      const bytes = await makePhoto(321, 123, format);
      assert.deepEqual(sniffImage(bytes), {
        format,
        width: 321,
        height: 123,
        animated: false,
      });
    }
    assert.equal(sniffImage(Buffer.from("GIF89a....")), null);
    assert.equal(sniffImage(Buffer.from("<svg></svg>")), null);
    assert.equal(sniffImage(Buffer.alloc(0)), null);
  });

  it("re-encodes to a clean, bounded JPEG whatever it was", async () => {
    for (const format of ["png", "webp"] as const) {
      const out = await normalizeImage(await makePhoto(3000, 4000, format), {
        minShortSide: 480,
      });
      assert.equal(out.sourceFormat, format);
      assert.equal(sniffImage(out.jpeg)?.format, "jpeg");
      assert.equal(Math.max(out.width, out.height), 2048);
      assert.match(out.sha256, /^[0-9a-f]{64}$/);
    }
  });

  it("rejects what it cannot trust", async () => {
    const code = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return "none";
      } catch (error) {
        return (error as ApiError).code;
      }
    };
    assert.equal(
      await code(normalizeImage(Buffer.alloc(0))),
      "invalid_request",
    );
    assert.equal(
      await code(normalizeImage(Buffer.from("GIF89a" + "x".repeat(50)))),
      "unsupported_media_type",
    );
    assert.equal(
      await code(
        normalizeImage(await makePhoto(300, 300), { minShortSide: 480 }),
      ),
      "photo_rejected",
    );
    assert.equal(
      await code(
        normalizeImage(await makePhoto(600, 600), { maxUploadBytes: 100 }),
      ),
      "payload_too_large",
    );
    // Valid headers, garbage body: the decoder must fail cleanly.
    const truncated = (await makePhoto(600, 600)).subarray(0, 300);
    assert.equal(await code(normalizeImage(truncated)), "photo_rejected");
  });

  it("scales large photos down for YouCam but leaves small ones alone", async () => {
    const big = await normalizeImage(await makePhoto(2000, 2800));
    const scaled = await youcamSourceJpeg(big.jpeg);
    const size = sniffImage(scaled)!;
    assert.equal(Math.max(size.width, size.height), YOUCAM_SOURCE_MAX_SIDE);
    const small = (await normalizeImage(await makePhoto(600, 800))).jpeg;
    assert.equal(await youcamSourceJpeg(small), small);
  });
});
