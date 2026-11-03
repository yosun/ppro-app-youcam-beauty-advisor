// Shared test helpers: synthetic photos, a fake ToolContext and a fetch stub.
// Tests never call YouCam. They run the app in simulated mode or stub `fetch`.

// A developer's shell may export a real key. Tests must never use it.
delete process.env.YOUCAM_API_KEY;
delete process.env.YOUCAM_ENABLED;
process.env.YOUCAM_POLL_MS = "1";
delete process.env.PPRO_PRODUCT_LINK_TEMPLATE;

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type {
  StoredPhoto,
  TargetResolution,
  ToolContext,
} from "../src/protocol/app-definition.ts";
import { newId } from "../src/protocol/ids.ts";
import type { Consent, EngineMode, UiState } from "../src/protocol/types.ts";
import { availableScreens, resolveTarget } from "../src/advisor/app.ts";
import {
  EMPTY_VIEW,
  emptyBeautyState,
  type BeautyState,
  type BeautyView,
} from "../src/advisor/types.ts";

/** A synthetic "selfie": a skin-toned oval on a plain wall. No real face. */
export async function makePhoto(
  width = 720,
  height = 960,
  format: "jpeg" | "png" | "webp" = "jpeg",
): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#d8dde6"/>
    <ellipse cx="${width / 2}" cy="${height / 2}" rx="${width * 0.34}" ry="${height * 0.38}" fill="#c99b7a"/>
    <rect x="${width * 0.36}" y="${height * 0.42}" width="${width * 0.1}" height="${height * 0.03}" fill="#3b2a20"/>
    <rect x="${width * 0.54}" y="${height * 0.42}" width="${width * 0.1}" height="${height * 0.03}" fill="#3b2a20"/>
    <rect x="${width * 0.42}" y="${height * 0.62}" width="${width * 0.16}" height="${height * 0.03}" fill="#b5656b"/>
  </svg>`;
  const image = sharp(Buffer.from(svg));
  if (format === "png") return image.png().toBuffer();
  if (format === "webp") return image.webp().toBuffer();
  return image.jpeg({ quality: 90 }).toBuffer();
}

export type FakeContext = ToolContext<BeautyState, BeautyView> & {
  images: Map<
    string,
    { bytes: Uint8Array; label: string; photoId: string | null }
  >;
  photos: Map<string, StoredPhoto>;
  set(partial: {
    state?: BeautyState;
    engine?: EngineMode;
    units?: number;
  }): void;
};

export async function fakeContext(
  options: { engine?: EngineMode; photo?: boolean; units?: number } = {},
): Promise<FakeContext> {
  const photos = new Map<string, StoredPhoto>();
  const images = new Map<
    string,
    { bytes: Uint8Array; label: string; photoId: string | null }
  >();
  if (options.photo !== false) {
    const jpeg = await makePhoto();
    const id = newId("pho");
    photos.set(id, {
      id,
      jpeg,
      sha256: randomUUID().replace(/-/g, ""),
      width: 720,
      height: 960,
      providerFileId: null,
      providerFileAt: null,
    });
  }
  let state = emptyBeautyState();
  let engine: EngineMode = options.engine ?? "simulated";
  let units = options.units ?? 100;
  const consent: Consent = {
    adult: true,
    photoAnalysis: true,
    at: Date.now(),
    source: "client",
  };
  const ui: UiState<BeautyView> = {
    screen: "chat",
    target: null,
    focus: null,
    following: false,
    mediaRequest: null,
    notice: null,
    nudge: null,
    capturing: false,
    available: ["chat"],
    view: { ...EMPTY_VIEW },
  };
  const context = {
    sessionId: newId("ses"),
    get state() {
      return state;
    },
    ui,
    consent,
    get engine() {
      return engine;
    },
    get unitsRemaining() {
      return units;
    },
    photos,
    images,
    photo(photoId?: string) {
      if (photoId) return photos.get(photoId) ?? null;
      return [...photos.values()].at(-1) ?? null;
    },
    hasPhoto: (id: string) => photos.has(id),
    hasImage: (id: string) => images.has(id),
    resolveTarget: (target: string): TargetResolution =>
      resolveTarget(state, target),
    availableScreens: () => availableScreens(state),
    async saveImage(bytes: Uint8Array, label: string, photoId: string | null) {
      const id = newId("img");
      images.set(id, { bytes, label, photoId });
      return id;
    },
    rememberProviderFile(photoId: string, fileId: string) {
      const photo = photos.get(photoId);
      if (photo) {
        photo.providerFileId = fileId;
        photo.providerFileAt = Date.now();
      }
    },
    set(partial: { state?: BeautyState; engine?: EngineMode; units?: number }) {
      if (partial.state) state = partial.state;
      if (partial.engine) engine = partial.engine;
      if (partial.units !== undefined) units = partial.units;
    },
  };
  return context as unknown as FakeContext;
}

/** Applies a tool run's state patch the way the runtime does. */
export function applyRun(
  context: FakeContext,
  run: { patch?: (state: BeautyState) => void },
) {
  if (!run.patch) return;
  const next = structuredClone(context.state) as BeautyState;
  run.patch(next);
  context.set({ state: next });
}

// --- fetch stub -----------------------------------------------------------------

export type StubRequest = {
  url: URL;
  method: string;
  body: string;
  /** The raw request body, for binary uploads. */
  bytes: Uint8Array;
  headers: Headers;
};
export type StubReply = Response | object | string | null;
export type Stub = (request: StubRequest) => StubReply | Promise<StubReply>;

/**
 * Replaces global fetch for the duration of a test. A handler returns a
 * Response, a JSON-able object (200), or null to say "not mine". An
 * unhandled request fails the test loudly instead of reaching the network.
 */
export function stubFetch(handler: Stub) {
  const original = globalThis.fetch;
  const calls: StubRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as string | URL, init);
    const bytes =
      request.method === "GET"
        ? new Uint8Array()
        : new Uint8Array(await request.arrayBuffer());
    const entry = {
      url: new URL(request.url),
      method: request.method,
      body: new TextDecoder().decode(bytes),
      bytes,
      headers: request.headers,
    };
    calls.push(entry);
    const reply = await handler(entry);
    if (reply === null)
      throw new Error(`Unexpected fetch: ${entry.method} ${entry.url}`);
    if (reply instanceof Response) return reply;
    if (typeof reply === "string") return new Response(reply);
    return Response.json(reply);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** A tiny YouCam API: upload, tasks that succeed, and result images. */
export function fakeYouCam(options: {
  skin?: Record<string, unknown>[];
  face?: Record<string, unknown>;
  tone?: Record<string, unknown>;
  taskError?: string;
  resultImage: Buffer;
  looks?: { id: string; title: string; category_name?: string }[];
}) {
  const tasks = new Map<string, { feature: string; body: unknown }>();
  let counter = 0;
  return stubFetch(({ url, method, body }) => {
    const host = url.hostname;
    if (host === "yce-api-01.makeupar.com") {
      if (url.pathname === "/s2s/v2.0/file" && method === "POST")
        return {
          data: {
            files: [
              {
                file_id: "file-1",
                requests: [
                  {
                    url: "https://upload.makeupar.com/put/file-1",
                    method: "PUT",
                    headers: {
                      "Content-Type": "image/jpeg",
                      "Content-Length": "1",
                    },
                  },
                ],
              },
            ],
          },
        };
      if (url.pathname.includes("/template/look-vto"))
        return {
          data: {
            templates: options.looks ?? [
              { id: "look_a", title: "Look A", category_name: "Daily" },
            ],
          },
        };
      const match = /\/task\/([a-z-]+)(?:\/(.+))?$/.exec(url.pathname);
      if (match && method === "POST") {
        const id = `task-${++counter}`;
        tasks.set(id, { feature: match[1], body: JSON.parse(body) });
        return { data: { task_id: id } };
      }
      if (match && method === "GET" && match[2]) {
        const task = tasks.get(match[2]);
        if (!task) return new Response("{}", { status: 404 });
        if (options.taskError)
          return {
            data: { task_status: "error", error_code: options.taskError },
          };
        const results: Record<string, unknown> =
          task.feature === "skin-analysis"
            ? { output: options.skin ?? [] }
            : task.feature === "face-attr-analysis"
              ? (options.face ?? {})
              : task.feature === "skin-tone-analysis"
                ? (options.tone ?? {})
                : { url: "https://results.s3.amazonaws.com/try-on.png" };
        return { data: { task_status: "success", results } };
      }
    }
    if (host === "upload.makeupar.com")
      return new Response(null, { status: 200 });
    if (host.endsWith(".amazonaws.com"))
      return new Response(new Uint8Array(options.resultImage), {
        headers: { "content-type": "image/png" },
      });
    return null;
  });
}
