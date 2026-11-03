// Constants shared by the server, the web app, the SDK and the spec tooling.
// This module (like everything in src/protocol) has no Node-only imports so
// the browser bundle can use it.

/** Protocol identifier. Breaking changes bump the number. */
export const PROTOCOL = "ppro-app/1";
export const API_PREFIX = "/ppro/v1";
export const MANIFEST_PATH = "/.well-known/ppro-app.json";
export const MCP_PATH = "/mcp";

export const APP_ID = "youcam-beauty-advisor";
export const APP_NAME = "YouCam Beauty Advisor";
// Kept in step with package.json by tests/meta.test.ts.
export const APP_VERSION = "0.1.0";

export const SKILL_ID = "youcam_beauty";
export const SKILL_NAME = "YouCam Beauty Professional";
export const PROVIDER_NAME = "YouCam AI by Perfect Corp";
export const PROVIDER_URL =
  "https://yce.perfectcorp.com/ai-api/agent/mcp-skill";

export const DISCLAIMER =
  "Results are AI-generated and for reference only. This is not medical, dermatological or cosmetic advice.";

/** Quick prompts the app offers a client who has not said anything yet. */
export const STARTERS = [
  "Analyze my skin",
  "What face shape do I have?",
  "Find my skin tone",
  "Show me everyday makeup looks",
  "Try a soft pink lip on me",
] as const;

export const LIMITS = {
  /** Longest client message, in characters. */
  clientMessageChars: 1000,
  /** Longest agent message, in characters. */
  agentMessageChars: 1600,
  /** Longest persona text a host may attach to a session. */
  personaChars: 1500,
  maxPhotos: 12,
  /** Raw upload ceiling; the browser downsizes before sending. */
  photoUploadBytes: 10 * 1024 * 1024,
  /** Longest side of a stored photo (YouCam SD accepts up to 2560). */
  photoMaxSide: 2048,
  /** Shortest side YouCam accepts for SD analysis. */
  photoMinShortSide: 480,
  /** Largest stored photo or result image after re-encoding. */
  storedImageBytes: 3_000_000,
  /** Image bytes one session may hold in memory. */
  sessionImageBytes: 80 * 1024 * 1024,
  maxSteps: 8,
  maxShades: 8,
  maxPicks: 12,
  /** Events kept per session for resume. */
  eventBuffer: 500,
  /** Longest a long-poll or wait_for_events call blocks. */
  waitMaxSeconds: 25,
  /** Tool calls per session per minute. */
  toolCallsPerMinute: 40,
  /** Messages per session per minute, per role. */
  messagesPerMinute: 30,
  /** Idempotency keys remembered per session. */
  idempotencyKeys: 200,
  /** Largest JSON request body. */
  jsonBodyBytes: 64 * 1024,
  /** Tool calls per consultation that may be YouCam analyses at once. */
  concurrentTools: 1,
} as const;

/** YouCam unit prices from the published feature-cost table. */
export const UNITS = {
  skinTone: 20,
  lookTryOn: 2,
  makeupTryOn: 1,
  /** Face-attribute and skin-analysis prices depend on the request. */
  skinAnalysis: [9, 12, 14, 16] as const,
  faceAttributes: [10, 20, 30] as const,
} as const;

export function skinAnalysisUnits(concerns: number) {
  return concerns <= 4 ? 9 : concerns <= 8 ? 12 : concerns <= 12 ? 14 : 16;
}

export function faceAttributeUnits(features: number) {
  return features <= 5 ? 10 : features <= 14 ? 20 : 30;
}
