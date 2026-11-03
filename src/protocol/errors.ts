// Error vocabulary. Every HTTP error body is
//   { "error": { "code": string, "message": string, "details"?: unknown } }
// Tool *outcomes* that are not failures of the request (no photo yet, budget
// spent, YouCam rejected the photo) come back as a normal 200 response with
// ok:false and one of the tool error codes below, so an agent can read them
// like any other tool result.

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_request",
  "invalid_arguments",
  "unsupported_media_type",
  "payload_too_large",
  "rate_limited",
  "session_ended",
  "consent_required",
  "photo_limit",
  "photo_rejected",
  "unknown_tool",
  "unknown_photo",
  "unknown_target",
  "vision_disabled",
  "content_blocked",
  "idempotency_conflict",
  "events_expired",
  "session_full",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const TOOL_ERROR_CODES = [
  // The client has not confirmed they are an adult and agreed to analysis.
  "consent_required",
  // No photo has been shared yet, or the photo_id is not in this session.
  "no_photo",
  "unknown_photo",
  // The session's provider budget cannot cover the call.
  "budget_exhausted",
  // The server-wide daily cap on provider tasks is reached.
  "daily_limit",
  // The provider is switched off (YOUCAM_ENABLED=false).
  "unavailable",
  // The provider refused the photo (too small, turned, too dark). The message
  // says how to retake it and `detail` carries the provider's own code.
  "photo_problem",
  // The provider answered but returned nothing usable, or an image could not be kept.
  "no_results",
  "save_failed",
  // The arguments were valid but name something that does not exist.
  "unknown_look",
  "unknown_image",
  "unknown_target",
  "no_effects",
  // The screen or control the call needs has no content yet.
  "nothing_to_show",
  // The text breaks the content rules (`say`).
  "content_blocked",
  // The arguments passed the schema but the text is unusable once cleaned
  // (for example a notice that is only a link).
  "invalid_arguments",
  // The session ended during the call.
  "session_ended",
  // Anything else; usually retryable.
  "tool_error",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra: { details?: unknown; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = extra.details;
    this.headers = extra.headers;
  }
}

export type ErrorBody = {
  error: { code: string; message: string; details?: unknown };
};

export function errorBody(error: ApiError): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}
