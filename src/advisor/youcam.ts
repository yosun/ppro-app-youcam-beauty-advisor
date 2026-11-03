import type { EngineMode } from "../protocol/types.ts";
import { envFlag, envNumber, envString } from "../support/env.ts";

// YouCam AI (Perfect Corp) REST client. It follows the official YouCam Agent
// Skills flow: upload through the File API, create an asynchronous task, poll
// it, then read the result. The API key comes only from server configuration
// (YOUCAM_API_KEY) and is never logged, stored or sent to a browser.
//
// Not affiliated with or endorsed by Perfect Corp. Use of the YouCam API is
// subject to Perfect Corp's own terms.

export const YOUCAM_API_ORIGIN = "https://yce-api-01.makeupar.com";

export type YouCamFeature =
  | "skin-analysis"
  | "face-attr-analysis"
  | "skin-tone-analysis"
  | "look-vto"
  | "makeup-vto";

const TASK_PATHS: Record<YouCamFeature, string> = {
  "skin-analysis": "/s2s/v2.1/task/skin-analysis",
  "face-attr-analysis": "/s2s/v2.0/task/face-attr-analysis",
  "skin-tone-analysis": "/s2s/v2.0/task/skin-tone-analysis",
  "look-vto": "/s2s/v2.0/task/look-vto",
  "makeup-vto": "/s2s/v2.0/task/makeup-vto",
};
const FILE_PATH = "/s2s/v2.0/file";
const LOOK_TEMPLATE_PATH = "/s2s/v2.0/task/template/look-vto";

export class YouCamError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = "YouCamError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * live: real YouCam calls. simulated: deterministic local results, labeled as
 * such (no API key). unavailable: switched off with YOUCAM_ENABLED=false.
 */
export function youcamMode(): EngineMode {
  if (!envFlag("YOUCAM_ENABLED", true)) return "unavailable";
  return envString("YOUCAM_API_KEY") ? "live" : "simulated";
}

const friendlyErrors: Record<string, string> = {
  error_below_min_image_size:
    "That photo is too small. Use one at least 480 pixels on its shorter side.",
  error_exceed_max_image_size: "That photo is too large. Try a smaller one.",
  error_src_face_too_small:
    "Move closer: your face should fill most of the photo (more than 60% of its width).",
  error_face_position_too_small:
    "Move closer: your face should fill most of the photo.",
  error_src_face_out_of_bound:
    "Keep your whole face inside the frame and centered.",
  error_face_position_out_of_boundary:
    "Keep your whole face inside the frame and centered.",
  error_face_position_invalid: "Center your face and look straight ahead.",
  error_face_angle_invalid: "Face the camera straight on, chin level.",
  error_large_face_angle:
    "Your head is turned or tilted. Face the camera straight on, chin level.",
  error_lighting_dark:
    "The photo is too dark. Try again in even, bright light.",
  error_no_face: "YouCam could not find a face in that photo.",
};

export function youcamFriendlyError(code: string) {
  const normalized = code.toLowerCase();
  for (const [key, message] of Object.entries(friendlyErrors))
    if (normalized.startsWith(key)) return message;
  return "YouCam could not process that photo. Try a clear, front-facing selfie in even light.";
}

/**
 * Whether a YouCam error says the photo itself is unusable (too small, turned,
 * dark, no face), as opposed to an outage, a bad key or a spent budget. Only a
 * photo problem is worth asking the client to retake.
 */
export function youcamPhotoProblem(code: string) {
  const normalized = code.toLowerCase();
  return Object.keys(friendlyErrors).some((key) => normalized.startsWith(key));
}

function apiKey() {
  const key = envString("YOUCAM_API_KEY");
  if (!key)
    throw new YouCamError("YouCam is not configured.", "not_configured");
  return key;
}

async function youcamRequest(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number },
) {
  let response: Response;
  try {
    response = await fetch(`${YOUCAM_API_ORIGIN}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    if (error instanceof YouCamError) throw error;
    throw new YouCamError(
      "YouCam did not respond in time.",
      "network_error",
      true,
    );
  }
  const text = await response.text();
  let body: Record<string, unknown> | null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = String(body?.error_code || body?.error || "").trim();
    throw new YouCamError(
      code ? youcamFriendlyError(code) : "YouCam rejected the request.",
      code || `http_${response.status}`,
      response.status >= 500 || response.status === 429,
    );
  }
  return body || {};
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Refuses a URL that points at this machine or a private network. YouCam hands
 * out pre-signed storage URLs; they should be public https hosts, and a bad
 * response must not be able to aim a request inward.
 */
export function assertPublicHttps(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new YouCamError("YouCam returned an invalid link.", "bad_url");
  }
  const host = parsed.hostname.toLowerCase();
  const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    literal ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  )
    throw new YouCamError("YouCam returned an unexpected link.", "bad_url");
  return parsed;
}

/** Uploads one JPEG through the File API and returns its YouCam file_id. */
export async function youcamUploadJpeg(jpeg: Buffer, fileName: string) {
  const meta = await youcamRequest(FILE_PATH, {
    method: "POST",
    body: {
      files: [
        {
          content_type: "image/jpeg",
          file_name: fileName,
          file_size: jpeg.byteLength,
        },
      ],
    },
  });
  const file = record((record(meta.data).files as unknown[] | undefined)?.[0]);
  const upload = record((file.requests as unknown[] | undefined)?.[0]);
  const fileId = typeof file.file_id === "string" ? file.file_id : "";
  const target = typeof upload.url === "string" ? upload.url : "";
  if (!fileId || !target)
    throw new YouCamError(
      "YouCam did not return an upload destination.",
      "upload_unavailable",
      true,
    );
  const destination = assertPublicHttps(target);
  // The pre-signed request names its own headers. Content-Length is set by
  // the runtime from the body and must not be forwarded by hand.
  const headers = new Headers();
  for (const [name, value] of Object.entries(record(upload.headers)))
    if (typeof value === "string" && name.toLowerCase() !== "content-length")
      headers.set(name, value);
  if (!headers.has("content-type")) headers.set("Content-Type", "image/jpeg");
  let put: Response;
  try {
    put = await fetch(destination, {
      method: upload.method === "POST" ? "POST" : "PUT",
      headers,
      body: new Uint8Array(jpeg),
      signal: AbortSignal.timeout(45_000),
      redirect: "error",
    });
  } catch {
    throw new YouCamError(
      "The photo upload to YouCam timed out.",
      "upload_failed",
      true,
    );
  }
  if (!put.ok)
    throw new YouCamError(
      "The photo upload to YouCam failed.",
      `upload_http_${put.status}`,
      put.status >= 500,
    );
  return fileId;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Creates a task and polls it to completion. Units are charged on success only. */
export async function youcamTask(
  feature: YouCamFeature,
  body: Record<string, unknown>,
  options: { timeoutMs?: number; pollMs?: number } = {},
) {
  const path = TASK_PATHS[feature];
  const created = await youcamRequest(path, { method: "POST", body });
  const taskId = String(record(created.data).task_id || "");
  if (!taskId)
    throw new YouCamError("YouCam did not start the task.", "task_missing");
  const deadline =
    Date.now() +
    (options.timeoutMs ?? envNumber("YOUCAM_TASK_TIMEOUT_MS", 60_000));
  const pollMs = options.pollMs ?? envNumber("YOUCAM_POLL_MS", 1_500);
  for (;;) {
    await wait(pollMs);
    const status = await youcamRequest(
      `${path}/${encodeURIComponent(taskId)}`,
      { method: "GET" },
    );
    const data = record(status.data);
    if (data.task_status === "success") return { taskId, data };
    if (data.task_status === "error") {
      const code = String(data.error_code || data.error || "task_error");
      throw new YouCamError(youcamFriendlyError(code), code);
    }
    if (Date.now() > deadline)
      throw new YouCamError(
        "YouCam is still working on that. Try again in a moment.",
        "task_timeout",
        true,
      );
  }
}

export type YouCamLook = { id: string; title: string; category: string };

const lookCache: { at: number; looks: YouCamLook[] } = { at: 0, looks: [] };

/** Clears the process-wide look-template cache. For tests. */
export function resetYouCamLookCache() {
  lookCache.at = 0;
  lookCache.looks = [];
}

// Template listing is free. Results are cached per process for six hours.
export async function youcamLookTemplates(): Promise<YouCamLook[]> {
  if (Date.now() - lookCache.at < 6 * 60 * 60_000 && lookCache.looks.length)
    return lookCache.looks;
  const looks: YouCamLook[] = [];
  let token = "";
  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({ page_size: "20" });
    if (token) params.set("starting_token", token);
    const body = await youcamRequest(`${LOOK_TEMPLATE_PATH}?${params}`, {
      method: "GET",
    });
    const data = record(body.data);
    const templates = Array.isArray(data.templates) ? data.templates : [];
    for (const raw of templates) {
      const item = record(raw);
      if (typeof item.id === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(item.id))
        looks.push({
          id: item.id,
          title: String(item.title || item.id).slice(0, 80),
          category: String(item.category_name || "Other").slice(0, 60),
        });
    }
    token = typeof data.next_token === "string" ? data.next_token : "";
    if (!token || !templates.length) break;
  }
  if (looks.length) {
    lookCache.at = Date.now();
    lookCache.looks = looks;
  }
  return looks;
}

const RESULT_HOSTS = [
  ".amazonaws.com",
  ".makeupar.com",
  ".perfectcorp.com",
  ".cloudfront.net",
];

/** Downloads one result image from YouCam's storage, bounded in size. */
export async function youcamDownloadImage(url: string, maxBytes = 12_000_000) {
  const parsed = assertPublicHttps(url);
  if (!RESULT_HOSTS.some((suffix) => parsed.hostname.endsWith(suffix)))
    throw new YouCamError(
      "YouCam returned an unexpected image host.",
      "bad_url",
    );
  let response: Response;
  try {
    response = await fetch(parsed, {
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
  } catch {
    throw new YouCamError(
      "Could not download a YouCam result.",
      "download_failed",
      true,
    );
  }
  if (!response.ok || !response.body)
    throw new YouCamError(
      "Could not download a YouCam result.",
      "download_failed",
      true,
    );
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new YouCamError(
      "A YouCam result image was too large.",
      "download_too_large",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new YouCamError(
        "A YouCam result image was too large.",
        "download_too_large",
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}
