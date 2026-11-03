// The seam between the generic ppro-app runtime (sessions, auth, events, HTTP,
// MCP) and one app. A ppro-app is an `AppDefinition`: its state, its screens,
// its tools and the instructions its advisor follows. The runtime knows
// nothing else about it. Types plus one identity helper (`defineTool`), so the
// file costs nothing to import.

import type { z } from "zod";
import type {
  Consent,
  EngineMode,
  MediaRequest,
  Notice,
  Nudge,
  UiState,
} from "./types.ts";

export type ToolGroup = "analysis" | "presentation" | "ui" | "session";

/** A stored photo, as tools see it. */
export type StoredPhoto = {
  id: string;
  jpeg: Uint8Array;
  sha256: string;
  width: number;
  height: number;
  /** The provider's id for this photo once uploaded, and when. */
  providerFileId: string | null;
  providerFileAt: number | null;
};

/** What a tool may change on the UI. Omitted keys are left alone. */
export type UiPatch<View> = {
  screen?: string;
  target?: string | null;
  /** Where the advisor is pointing. "Follow" returns the client here. */
  focus?: { screen: string; target: string | null } | null;
  following?: boolean;
  mediaRequest?: MediaRequest | null;
  notice?: Notice | null;
  nudge?: Nudge | null;
  view?: Partial<View>;
};

export type ToolFailure = {
  code: string;
  message: string;
  retryable?: boolean;
  detail?: string;
};

/** What a tool returns to the runtime. */
export type ToolRun<State, View> = {
  ok: boolean;
  /** Provider units to charge. Charged only when ok is true. */
  units?: number;
  /** The compact view returned to the agent. */
  result: Record<string, unknown>;
  error?: ToolFailure;
  /** A transcript entry the client sees (role "tool"). */
  entry?: { kind: string; body: string; data?: Record<string, unknown> };
  /**
   * Changes the app state. Applied to a copy and committed all at once; the
   * runtime announces whatever top-level parts changed as app.updated events.
   */
  patch?: (state: State) => void;
  ui?: UiPatch<View>;
};

/** Everything a tool may read or do. Tools never touch the session directly. */
export interface ToolContext<State, View> {
  readonly sessionId: string;
  readonly state: Readonly<State>;
  readonly ui: Readonly<UiState<View>>;
  readonly consent: Readonly<Consent>;
  readonly engine: EngineMode;
  readonly unitsRemaining: number;
  /** A shared photo by id, or the latest one. */
  photo(photoId?: string): StoredPhoto | null;
  hasPhoto(photoId: string): boolean;
  /** Whether a result image of this session exists. */
  hasImage(imageId: string): boolean;
  /** Whether a target exists in the current state, and the screen it is on. */
  resolveTarget(target: string): TargetResolution;
  /** Screens that have content now. */
  availableScreens(): string[];
  /** Stores a result image made from `photoId`. Null if it cannot be kept. */
  saveImage(
    bytes: Uint8Array,
    label: string,
    photoId: string | null,
  ): Promise<string | null>;
  /** Remembers the provider's file id for a photo, to skip the next upload. */
  rememberProviderFile(photoId: string, fileId: string): void;
}

/** How an app author writes a tool: arguments are typed by the input schema. */
export type ToolDefinition<State, View, Args> = {
  name: string;
  title: string;
  /** Written for the model: when to call it and what comes back. */
  description: string;
  group: ToolGroup;
  input: z.ZodType<Args, unknown>;
  /** Cost label for the manifest, for example "9-16 units" or "free". */
  cost: string;
  /** Exact units this call will spend, checked against the budget first. */
  units?: (args: Args) => number;
  /** The call needs a shared photo (and the client's consent to analyze it). */
  needsPhoto?: boolean;
  /** The call goes to the provider and fails when the engine is unavailable. */
  usesEngine?: boolean;
  readOnly?: boolean;
  run(
    ctx: ToolContext<State, View>,
    args: Args,
  ): Promise<ToolRun<State, View>> | ToolRun<State, View>;
};

/**
 * A tool as the runtime stores it. The runtime validates arguments with
 * `input` before it calls `run`, so by then they have the right type.
 */
export type RegisteredTool<State, View> = Omit<
  ToolDefinition<State, View, unknown>,
  "input" | "units" | "run"
> & {
  input: z.ZodType;
  units?: (args: unknown) => number;
  run(
    ctx: ToolContext<State, View>,
    args: unknown,
  ): Promise<ToolRun<State, View>> | ToolRun<State, View>;
};

/** Registers a typed tool. The one place its argument type is erased. */
export function defineTool<State, View, Args>(
  tool: ToolDefinition<State, View, Args>,
): RegisteredTool<State, View> {
  return tool as unknown as RegisteredTool<State, View>;
}

export type ScreenSpec = {
  id: string;
  title: string;
  description: string;
  /** The state part that fills the screen, for the manifest. */
  filledBy: string | null;
};

export type TargetSpec = {
  section: string;
  screen: string;
  item: string;
  description: string;
};

export type InstructionsInput<State> = {
  advisorName: string;
  pronouns: string | null;
  persona: string | null;
  clientName: string | null;
  minutesLeft: number;
  unitsLeft: number;
  photoCount: number;
  /** Whether the agent may fetch image bytes of the client's photos. */
  agentVision: boolean;
  consent: Consent;
  engine: EngineMode;
  style: "chat" | "call";
  state: State;
};

export type TargetResolution =
  | { ok: true; screen: string }
  | { ok: false; message: string; valid: string[] };

export interface AppDefinition<State, View = Record<string, unknown>> {
  id: string;
  name: string;
  version: string;
  description: string;
  skill: { id: string; name: string };
  provider: { name: string; url: string };
  disclaimer: string;
  /** Rules the advisor must follow. Part of the standard, shown in the manifest. */
  guardrails: readonly string[];
  /** Quick prompts offered to a client who has not said anything yet. */
  starters: readonly string[];
  /** Transcript kinds the app's tools add, for the manifest. */
  messageKinds: readonly string[];
  screens: readonly ScreenSpec[];
  targets: readonly TargetSpec[];
  /** JSON Schema of the `app` object, for the manifest. */
  stateSchema: Record<string, unknown>;
  tools: readonly RegisteredTool<State, View>[];
  initialState(): State;
  initialView(): View;
  /** Validates the view changes a client may report (a slider, a toggle). */
  viewSchema: z.ZodType<Partial<View>, unknown>;
  /** Screens that have content now. The first screen is always included. */
  availableScreens(state: State): string[];
  /** Whether a target exists in the current state, and the screen it is on. */
  resolveTarget(state: State, target: string): TargetResolution;
  /** A compact summary of what has been shown, for `get_session_state`. */
  summarize(state: State): Record<string, unknown>;
  /** Every target that exists now, for error messages and state reads. */
  validTargets(state: State): string[];
  /** Removes references to photos and result images that were deleted. */
  dropMedia(state: State, ids: ReadonlySet<string>): void;
  engineMode(): EngineMode;
  /** Provider units one session may spend. */
  sessionUnits(): number;
  instructions(input: InstructionsInput<State>): string;
}
