// Zod schemas for the PPRO App API envelope: request bodies, the session
// snapshot, messages, events and tool responses. They validate what the server
// receives and are the source of the OpenAPI document and the JSON Schemas in
// spec/. The drift checks at the bottom fail the build if a schema and its
// TypeScript type in types.ts ever disagree.

import { z } from "zod";
import { LIMITS } from "./constants.ts";
import {
  EVENT_TYPES,
  PRESENCE_STATES,
  type Budget,
  type Consent,
  type EventMap,
  type EventType,
  type Message,
  type PhotoMeta,
  type ToolResponse,
  type UiState,
} from "./types.ts";

// --- Requests -----------------------------------------------------------------

export const createSessionBody = z
  .object({
    advisor: z
      .object({
        name: z.string().max(40).optional(),
        pronouns: z.string().max(24).optional(),
        persona: z
          .string()
          .max(LIMITS.personaChars)
          .optional()
          .describe(
            "Voice and personality notes for the advisor. Never shown to the client.",
          ),
      })
      .strict()
      .optional(),
    client: z
      .object({ display_name: z.string().max(40).optional() })
      .strict()
      .optional(),
    minutes: z.number().min(1).max(600).optional(),
    agent_vision: z
      .boolean()
      .optional()
      .describe(
        "Let the advisor fetch image bytes of the client's photos. Off by default.",
      ),
    locale: z.string().max(16).optional(),
    host_origin: z
      .string()
      .max(200)
      .optional()
      .describe(
        "The embedding page's origin. Must be one the operator allowed.",
      ),
    units: z.number().int().min(1).max(10_000).optional(),
    consent: z
      .object({
        adult: z.boolean().optional(),
        photo_analysis: z.boolean().optional(),
      })
      .strict()
      .optional()
      .describe("Only if the host collected these from the client itself."),
  })
  .strict();

export const demoSessionBody = z
  .object({
    advisor_name: z.string().max(40).optional(),
    client_name: z.string().max(40).optional(),
    agent_vision: z.boolean().optional(),
  })
  .strict();

export const messageBody = z
  .object({
    text: z.string().min(1).max(4000),
    role: z
      .enum(["client", "agent"])
      .optional()
      .describe(
        "Required for a host (it relays the client). Otherwise implied by the token.",
      ),
  })
  .strict();

export const consentBody = z
  .object({
    adult: z.boolean().optional(),
    photo_analysis: z.boolean().optional(),
  })
  .strict();

export const presenceBody = z
  .object({ state: z.enum(PRESENCE_STATES) })
  .strict();

export const mintTokenBody = z
  .object({ role: z.enum(["agent", "client"]) })
  .strict();

export const uiEventBody = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("navigate"), screen: z.string().max(24) })
    .strict(),
  z.object({ type: z.literal("follow") }).strict(),
  z.object({ type: z.literal("focus"), target: z.string().max(60) }).strict(),
  z
    .object({
      type: z.literal("view"),
      view: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z.object({ type: z.literal("capture"), open: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("dismiss"),
      what: z.enum(["notice", "media_request", "nudge"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("action"),
      action: z.enum(["copy", "save"]),
      target: z.string().max(60).nullish(),
    })
    .strict(),
]);

// --- Responses ----------------------------------------------------------------

export const photoMeta = z.object({
  id: z.string(),
  at: z.number(),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
});

export const message = z.object({
  seq: z.number().int().min(1),
  at: z.number(),
  role: z.enum(["client", "agent", "tool", "system"]),
  kind: z
    .string()
    .describe("text and photo, or a kind the app adds for its tool results."),
  body: z.string(),
  spoken: z
    .string()
    .optional()
    .describe("Agent text only: the same words made safe to read aloud."),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const consent = z.object({
  adult: z.boolean(),
  photoAnalysis: z.boolean(),
  at: z.number().nullable(),
  source: z.enum(["client", "host"]).nullable(),
});

export const budget = z.object({
  unitsTotal: z.number(),
  unitsUsed: z.number(),
  unitsRemaining: z.number(),
});

export const uiState = z.object({
  screen: z.string(),
  target: z.string().nullable(),
  focus: z
    .object({ screen: z.string(), target: z.string().nullable() })
    .nullable(),
  following: z.boolean(),
  mediaRequest: z
    .object({
      kind: z.literal("photo"),
      mode: z.enum(["camera", "upload", "either"]),
      reason: z.string(),
      at: z.number(),
    })
    .nullable(),
  notice: z
    .object({
      text: z.string(),
      tone: z.enum(["info", "warn"]),
      at: z.number(),
    })
    .nullable(),
  nudge: z
    .object({ target: z.string(), label: z.string(), at: z.number() })
    .nullable(),
  capturing: z.boolean(),
  available: z.array(z.string()),
  view: z.record(z.string(), z.unknown()),
});

export const session = z.object({
  id: z.string(),
  rev: z.number().int().min(1),
  phase: z.enum(["active", "ended"]),
  createdAt: z.number(),
  expiresAt: z.number(),
  endedAt: z.number().nullable(),
  endReason: z.enum(["client", "agent", "host", "expired"]).nullable(),
  advisor: z.object({
    name: z.string(),
    pronouns: z.string().nullable(),
    persona: z
      .string()
      .nullable()
      .optional()
      .describe("Present for the host and the agent, never for the client."),
  }),
  client: z.object({ displayName: z.string().nullable() }),
  consent,
  options: z.object({
    agentVision: z.boolean(),
    locale: z.string(),
    hostOrigin: z.string().nullable(),
    minutes: z.number(),
  }),
  budget,
  engine: z.object({ mode: z.enum(["live", "simulated", "unavailable"]) }),
  photos: z.array(photoMeta),
  messages: z.array(message),
  messageCount: z.number().int(),
  app: z
    .unknown()
    .describe("The app's own state. The manifest's `state` describes it."),
  ui: uiState,
  presence: z.enum(PRESENCE_STATES),
});

export const toolResponse = z.object({
  ok: z.boolean(),
  tool: z.string(),
  callId: z.string(),
  units: z.number(),
  result: z.record(z.string(), z.unknown()),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional(),
      detail: z.string().optional(),
    })
    .optional(),
  rev: z.number().int(),
  unitsRemaining: z.number(),
});

export const errorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

// --- Events -------------------------------------------------------------------

const endReason = z.enum(["client", "agent", "host", "expired"]);

export const eventData = {
  "session.started": z.object({
    session: z.object({ id: z.string(), expiresAt: z.number() }),
  }),
  "session.ended": z.object({ reason: endReason }),
  "session.warning": z.object({ minutesLeft: z.number() }),
  "consent.updated": z.object({ consent }),
  "message.created": z.object({ message }),
  "photo.added": z.object({ photo: photoMeta }),
  "photo.rejected": z.object({ code: z.string(), message: z.string() }),
  "photo.deleted": z.object({ photoId: z.string() }),
  "tool.started": z.object({ callId: z.string(), tool: z.string() }),
  "tool.completed": z.object({
    callId: z.string(),
    tool: z.string(),
    ok: z.boolean(),
    units: z.number(),
    errorCode: z.string().optional(),
  }),
  "app.updated": z.object({ kind: z.string(), value: z.unknown() }),
  "ui.changed": z.object({
    ui: uiState,
    by: z.enum(["agent", "client", "app"]),
  }),
  "client.action": z.object({
    action: z.enum(["copy", "save"]),
    target: z.string().nullable(),
  }),
  "presence.changed": z.object({ presence: z.enum(PRESENCE_STATES) }),
  "budget.updated": budget,
} as const satisfies Record<EventType, z.ZodType>;

const actor = z.enum(["client", "agent", "app", "host"]);

/** One schema per event type: the envelope plus that type's data. */
export const eventSchemas = {} as Record<EventType, z.ZodType>;
for (const type of EVENT_TYPES)
  eventSchemas[type] = z.object({
    rev: z.number().int(),
    at: z.number(),
    type: z.literal(type),
    actor,
    data: eventData[type],
  });

export const eventBatch = z.object({
  events: z.array(
    z.union(
      Object.values(eventSchemas) as [z.ZodType, z.ZodType, ...z.ZodType[]],
    ),
  ),
  rev: z
    .number()
    .int()
    .describe(
      "Where to resume. Safe: every matching event up to it is in `events`.",
    ),
  phase: z.enum(["active", "ended"]),
});

// --- Drift checks -------------------------------------------------------------
// Each schema's type and the matching TypeScript type must be assignable to
// each other, or this file stops compiling.

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const _drift: [
  Mutual<z.infer<typeof photoMeta>, PhotoMeta>,
  Mutual<z.infer<typeof message>, Message>,
  Mutual<z.infer<typeof consent>, Consent>,
  Mutual<z.infer<typeof budget>, Budget>,
  Mutual<z.infer<typeof uiState>, UiState>,
  Mutual<z.infer<typeof toolResponse>, ToolResponse>,
  { [K in EventType]: Mutual<z.infer<(typeof eventData)[K]>, EventMap[K]> },
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  {
    "session.started": true,
    "session.ended": true,
    "session.warning": true,
    "consent.updated": true,
    "message.created": true,
    "photo.added": true,
    "photo.rejected": true,
    "photo.deleted": true,
    "tool.started": true,
    "tool.completed": true,
    "app.updated": true,
    "ui.changed": true,
    "client.action": true,
    "presence.changed": true,
    "budget.updated": true,
  },
];
