// PPRO App API v1: the generic envelope every ppro-app shares. A session has
// an identity, a transcript, shared photos, a UI state, a budget and one
// app-defined `app` object whose shape the manifest describes. Events announce
// every change. Nothing in this file knows about beauty: the YouCam Beauty
// Advisor's own state and tools live in src/advisor.
//
// Types plus a few small constant lists, no Node-only code, so the browser
// bundle can import it.

/** Who a token speaks for. `host` creates sessions; `agent` is the advisor. */
export type Role = "host" | "agent" | "client";
/** Who caused an event. `app` is the server itself (timers, tool results). */
export type Actor = "client" | "agent" | "app" | "host";

export const PRESENCE_STATES = [
  "idle",
  "thinking",
  "speaking",
  "listening",
] as const;
export type Presence = (typeof PRESENCE_STATES)[number];

/** How the app's backing service is running. */
export type EngineMode = "live" | "simulated" | "unavailable";
export type SessionPhase = "active" | "ended";
export type EndReason = "client" | "agent" | "host" | "expired";

// --- Photos and images -------------------------------------------------------

/** A photo the client shared. The bytes never appear in a snapshot. */
export type PhotoMeta = {
  id: string;
  at: number;
  width: number;
  height: number;
  bytes: number;
};

/** An image the app made from a photo (an overlay or a try-on). */
export type ImageRef = { id: string; label: string };

// --- Transcript --------------------------------------------------------------

export type MessageRole = "client" | "agent" | "tool" | "system";

export type Message = {
  /** Position in the transcript, starting at 1. */
  seq: number;
  at: number;
  role: MessageRole;
  /** `text` and `photo` are generic; apps add kinds for their tool results. */
  kind: string;
  body: string;
  /** Agent text only: the same words made safe to read aloud. */
  spoken?: string;
  /** Structured content for tool entries (scores, images, swatches...). */
  data?: Record<string, unknown>;
};

// --- UI ----------------------------------------------------------------------

export type MediaRequest = {
  kind: "photo";
  mode: "camera" | "upload" | "either";
  reason: string;
  at: number;
};

export type Notice = { text: string; tone: "info" | "warn"; at: number };

/** A pointer to something worth looking at that did not take the screen. */
export type Nudge = { target: string; label: string; at: number };

/**
 * What the client sees right now. The advisor writes it with UI tools, the
 * client writes it by using the app, and both can read it.
 */
export type UiState<View = Record<string, unknown>> = {
  screen: string;
  /** The item the client is looking at, or null. */
  target: string | null;
  /** Where the advisor is pointing, whether or not the client followed. */
  focus: { screen: string; target: string | null } | null;
  /** The app follows the advisor until the client takes over. */
  following: boolean;
  mediaRequest: MediaRequest | null;
  notice: Notice | null;
  nudge: Nudge | null;
  /** The client has the camera or the photo picker open. */
  capturing: boolean;
  /** Screens that have content. The first screen is always available. */
  available: string[];
  /** App-defined view state, for example a before-and-after slider. */
  view: View;
};

// --- Session -----------------------------------------------------------------

export type Consent = {
  /** The client confirmed they are 18 or older. */
  adult: boolean;
  /** The client agreed to analysis of their own photo. */
  photoAnalysis: boolean;
  at: number | null;
  /** Who gave it: the client in the app, or the host that collected it. */
  source: "client" | "host" | null;
};

export type Budget = {
  unitsTotal: number;
  unitsUsed: number;
  unitsRemaining: number;
};

export type Session<App = unknown, View = Record<string, unknown>> = {
  id: string;
  /** Increases by one on every change. Events carry the rev they produced. */
  rev: number;
  phase: SessionPhase;
  createdAt: number;
  expiresAt: number;
  endedAt: number | null;
  endReason: EndReason | null;
  advisor: {
    name: string;
    pronouns: string | null;
    /** Host-supplied voice and personality notes. Agent and host only. */
    persona?: string | null;
  };
  client: { displayName: string | null };
  consent: Consent;
  options: {
    /** Whether the agent may fetch image bytes of the client's photos. */
    agentVision: boolean;
    locale: string;
    hostOrigin: string | null;
    minutes: number;
  };
  budget: Budget;
  engine: { mode: EngineMode };
  photos: PhotoMeta[];
  /** The most recent messages. `messageCount` is the transcript length. */
  messages: Message[];
  messageCount: number;
  /** App-defined state, described by the manifest's `state` schema. */
  app: App;
  ui: UiState<View>;
  presence: Presence;
};

// --- Events ------------------------------------------------------------------

export const CLIENT_ACTIONS = ["copy", "save"] as const;
export type ClientAction = (typeof CLIENT_ACTIONS)[number];

export type EventMap = {
  "session.started": { session: { id: string; expiresAt: number } };
  "session.ended": { reason: EndReason };
  "session.warning": { minutesLeft: number };
  "consent.updated": { consent: Consent };
  "message.created": { message: Message };
  "photo.added": { photo: PhotoMeta };
  "photo.rejected": { code: string; message: string };
  "photo.deleted": { photoId: string };
  "tool.started": { callId: string; tool: string };
  "tool.completed": {
    callId: string;
    tool: string;
    ok: boolean;
    units: number;
    errorCode?: string;
  };
  /** One top-level part of the app state changed; `value` is its new value. */
  "app.updated": { kind: string; value: unknown };
  "ui.changed": { ui: UiState; by: "agent" | "client" | "app" };
  /** The client did something that changes nothing: copied shades, saved an image. */
  "client.action": { action: ClientAction; target: string | null };
  "presence.changed": { presence: Presence };
  "budget.updated": Budget;
};
export type EventType = keyof EventMap;

export type PproEvent<T extends EventType = EventType> = {
  [K in T]: {
    rev: number;
    at: number;
    type: K;
    actor: Actor;
    data: EventMap[K];
  };
}[T];

export const EVENT_TYPES = [
  "session.started",
  "session.ended",
  "session.warning",
  "consent.updated",
  "message.created",
  "photo.added",
  "photo.rejected",
  "photo.deleted",
  "tool.started",
  "tool.completed",
  "app.updated",
  "ui.changed",
  "client.action",
  "presence.changed",
  "budget.updated",
] as const satisfies readonly EventType[];

// --- Tool results ------------------------------------------------------------

export type ToolError = {
  code: string;
  message: string;
  retryable?: boolean;
  /** The provider's own error code, when there is one. */
  detail?: string;
};

export type ToolResponse = {
  ok: boolean;
  tool: string;
  callId: string;
  /** Provider units this call used. 0 for failures and free tools. */
  units: number;
  /** The compact view meant for the agent. */
  result: Record<string, unknown>;
  error?: ToolError;
  /** Session rev after the call. */
  rev: number;
  unitsRemaining: number;
};
