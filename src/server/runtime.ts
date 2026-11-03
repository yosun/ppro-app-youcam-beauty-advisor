import { createHash } from "node:crypto";
import { normalizeImage } from "../support/image.ts";
import type {
  AppDefinition,
  RegisteredTool,
  StoredPhoto,
  ToolContext,
  ToolRun,
  UiPatch,
} from "../protocol/app-definition.ts";
import { RUNTIME_TOOLS, uiTools } from "../protocol/core-tools.ts";
import { LIMITS } from "../protocol/constants.ts";
import { ApiError } from "../protocol/errors.ts";
import { newId } from "../protocol/ids.ts";
import {
  cleanAgentText,
  cleanClientText,
  speakable,
} from "../protocol/text.ts";
import type {
  Actor,
  EndReason,
  Message,
  MessageRole,
  PhotoMeta,
  Presence,
  Session,
  ToolResponse,
  UiState,
} from "../protocol/types.ts";
import type { Config } from "./config.ts";
import { SessionRecord, type EventBatch, type StoredImage } from "./session.ts";
import { mintToken } from "./tokens.ts";

// The generic ppro-app runtime: sessions, the transcript, photos, consent, the
// UI state and the tool pipeline. It knows an app only through its
// AppDefinition. Everything is synchronous in memory except the work a tool
// does, and tool results are committed in one step, so a snapshot is never
// half-updated.

type Record_ = Record<string, unknown>;

export type CreateSessionInput = {
  advisor?: { name?: string; pronouns?: string; persona?: string };
  client?: { displayName?: string };
  minutes?: number;
  agentVision?: boolean;
  locale?: string;
  hostOrigin?: string;
  units?: number;
  /** The host attests that it collected these from the client. */
  consent?: { adult?: boolean; photoAnalysis?: boolean };
};

export type ViewerRole = "host" | "agent" | "client";

export type UiEventInput =
  | { type: "navigate"; screen: string }
  | { type: "follow" }
  | { type: "focus"; target: string }
  | { type: "view"; view: Record_ }
  | { type: "capture"; open: boolean }
  | { type: "dismiss"; what: "notice" | "media_request" | "nudge" }
  | { type: "action"; action: "copy" | "save"; target?: string | null };

type ToolOptions = { idempotencyKey?: string };

const SESSION_MESSAGE_LIMIT = 1000;

function clean(value: string | undefined, max: number): string | null {
  const text = value
    // eslint-disable-next-line no-control-regex
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, max) : null;
}

export class Runtime<State extends Record_, View extends Record_> {
  readonly app: AppDefinition<State, View>;
  readonly config: Config;
  private readonly sessions = new Map<string, SessionRecord<State, View>>();
  /** The clock every time-dependent decision uses. Injectable for tests. */
  readonly now: () => number;
  private readonly uiTools: RegisteredTool<State, View>[];
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    app: AppDefinition<State, View>,
    config: Config,
    options: { now?: () => number } = {},
  ) {
    this.app = app;
    this.config = config;
    this.now = options.now ?? Date.now;
    this.uiTools = uiTools<State, View>();
  }

  /** Every tool the agent can call through the pipeline, in manifest order. */
  allTools(): RegisteredTool<State, View>[] {
    return [...this.app.tools, ...this.uiTools];
  }

  // --- Lifecycle ---------------------------------------------------------------

  start() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** Ends sessions that ran out of time and forgets old ended ones. */
  sweep() {
    const now = this.now();
    for (const [id, rec] of this.sessions) {
      if (rec.phase === "active") {
        if (now >= rec.expiresAt) {
          this.end(rec, "expired", "app");
          continue;
        }
        for (const minutes of [5, 1]) {
          if (
            !rec.warned.has(minutes) &&
            rec.expiresAt - now <= minutes * 60_000 &&
            rec.expiresAt - rec.createdAt > minutes * 60_000 * 2
          ) {
            rec.warned.add(minutes);
            rec.emit("session.warning", "app", { minutesLeft: minutes }, now);
          }
        }
      } else if (
        rec.endedAt !== null &&
        now - rec.endedAt > this.config.endedRetentionMs
      ) {
        this.sessions.delete(id);
      }
    }
  }

  get sessionCount() {
    return this.sessions.size;
  }

  create(input: CreateSessionInput) {
    const now = this.now();
    const minutes = Math.min(
      this.config.maxMinutes,
      Math.max(1, Math.round(input.minutes ?? this.config.defaultMinutes)),
    );
    const id = newId("ses");
    const cap = this.app.sessionUnits();
    const consent = {
      adult: input.consent?.adult === true,
      photoAnalysis: input.consent?.photoAnalysis === true,
      at: input.consent ? now : null,
      source: input.consent ? ("host" as const) : null,
    };
    const state = this.app.initialState();
    const rec = new SessionRecord<State, View>({
      id,
      now,
      expiresAt: now + minutes * 60_000,
      advisor: {
        name: clean(input.advisor?.name, 40) ?? "Your advisor",
        pronouns: clean(input.advisor?.pronouns, 24),
        persona: clean(input.advisor?.persona, LIMITS.personaChars),
      },
      client: { displayName: clean(input.client?.displayName, 40) },
      consent,
      options: {
        agentVision: input.agentVision === true,
        locale: clean(input.locale, 16) ?? "en",
        hostOrigin: input.hostOrigin ?? null,
        minutes,
      },
      unitsTotal: Math.min(cap, Math.max(1, Math.round(input.units ?? cap))),
      state,
      ui: {
        screen: this.app.availableScreens(state)[0] ?? "chat",
        target: null,
        focus: null,
        following: false,
        mediaRequest: null,
        notice: null,
        nudge: null,
        capturing: false,
        available: this.app.availableScreens(state),
        view: this.app.initialView(),
      },
    });
    this.sessions.set(id, rec);
    rec.emit(
      "session.started",
      "host",
      { session: { id, expiresAt: rec.expiresAt } },
      now,
    );
    return rec;
  }

  /** Looks up a session, or 404. Expired sessions are ended on the way. */
  get(id: string): SessionRecord<State, View> {
    const rec = this.sessions.get(id);
    if (!rec) throw new ApiError(404, "not_found", "No such session.");
    if (rec.phase === "active" && this.now() >= rec.expiresAt)
      this.end(rec, "expired", "app");
    return rec;
  }

  private active(id: string): SessionRecord<State, View> {
    const rec = this.get(id);
    if (rec.phase !== "active")
      throw new ApiError(409, "session_ended", "This consultation has ended.");
    rec.lastActivity = this.now();
    return rec;
  }

  tokensFor(rec: SessionRecord<State, View>) {
    const exp = Math.ceil(
      (rec.expiresAt + this.config.endedRetentionMs) / 1000,
    );
    const secret = this.config.signingSecret;
    return {
      agent: mintToken(secret, { sid: rec.id, role: "agent", exp }),
      client: mintToken(secret, { sid: rec.id, role: "client", exp }),
    };
  }

  tokenFor(rec: SessionRecord<State, View>, role: "agent" | "client") {
    return this.tokensFor(rec)[role];
  }

  // --- Reading -----------------------------------------------------------------

  snapshot(
    rec: SessionRecord<State, View>,
    role: ViewerRole,
    options: { messages?: number } = {},
  ): Session<State, View> {
    const count = Math.min(300, Math.max(0, options.messages ?? 100));
    const session: Session<State, View> = {
      id: rec.id,
      rev: rec.rev,
      phase: rec.phase,
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
      endedAt: rec.endedAt,
      endReason: rec.endReason,
      advisor: {
        name: rec.advisor.name,
        pronouns: rec.advisor.pronouns,
        ...(role === "client" ? {} : { persona: rec.advisor.persona }),
      },
      client: { ...rec.client },
      consent: { ...rec.consent },
      options: { ...rec.options },
      budget: {
        unitsTotal: rec.unitsTotal,
        unitsUsed: rec.unitsUsed,
        unitsRemaining: rec.unitsRemaining,
      },
      engine: { mode: this.app.engineMode() },
      photos: [...rec.photos.values()].map((photo) => ({ ...photo.meta })),
      messages: count ? rec.messages.slice(-count) : [],
      messageCount: rec.messages.length,
      app: rec.state,
      ui: rec.ui,
      presence: rec.presence,
    };
    return structuredClone(session);
  }

  /** The advisor's briefing, rendered for the session as it stands now. */
  instructions(rec: SessionRecord<State, View>, style: "chat" | "call") {
    return this.app.instructions({
      advisorName: rec.advisor.name,
      pronouns: rec.advisor.pronouns,
      persona: rec.advisor.persona,
      clientName: rec.client.displayName,
      minutesLeft: Math.max(
        0,
        Math.ceil((rec.expiresAt - this.now()) / 60_000),
      ),
      unitsLeft: rec.unitsRemaining,
      photoCount: rec.photos.size,
      agentVision: rec.options.agentVision,
      consent: rec.consent,
      engine: this.app.engineMode(),
      style,
      state: rec.state,
    });
  }

  /** A compact read for the `get_session_state` tool. */
  compactState(rec: SessionRecord<State, View>, messages = 12) {
    return {
      rev: rec.rev,
      phase: rec.phase,
      minutes_left: Math.max(
        0,
        Math.ceil((rec.expiresAt - this.now()) / 60_000),
      ),
      units_remaining: rec.unitsRemaining,
      engine: this.app.engineMode(),
      consent: rec.consent,
      client: rec.client,
      photos: [...rec.photos.values()].map(({ meta }) => ({
        id: meta.id,
        width: meta.width,
        height: meta.height,
      })),
      client_view: {
        screen: rec.ui.screen,
        target: rec.ui.target,
        following: rec.ui.following,
        capturing: rec.ui.capturing,
        photo_requested: Boolean(rec.ui.mediaRequest),
      },
      available_screens: rec.ui.available,
      valid_targets: this.app.validTargets(rec.state),
      shown: this.app.summarize(rec.state),
      presence: rec.presence,
      recent_messages: rec.messages.slice(-messages).map((m) => ({
        seq: m.seq,
        role: m.role,
        kind: m.kind,
        text: m.body,
      })),
    };
  }

  // --- Messages ------------------------------------------------------------------

  private addMessage(
    rec: SessionRecord<State, View>,
    actor: Actor,
    message: Omit<Message, "seq" | "at">,
  ): Message {
    if (rec.messages.length >= SESSION_MESSAGE_LIMIT)
      throw new ApiError(
        409,
        "session_full",
        "This consultation's transcript is full.",
      );
    const entry: Message = {
      seq: rec.messages.length + 1,
      at: this.now(),
      ...message,
    };
    rec.messages.push(entry);
    rec.emit("message.created", actor, { message: entry }, entry.at);
    return entry;
  }

  /** The client's words (also used by a host relaying speech). */
  clientMessage(id: string, text: unknown, actor: Actor = "client") {
    const rec = this.active(id);
    const body = cleanClientText(text);
    if (!body)
      throw new ApiError(400, "invalid_request", "Write a message first.");
    this.takeToken(rec.clientBucket, "messages");
    return this.addMessage(rec, actor, { role: "client", kind: "text", body });
  }

  /** The advisor's words. Links and markdown are removed; unsafe text is refused. */
  agentMessage(id: string, text: unknown) {
    const rec = this.active(id);
    const cleaned = cleanAgentText(text);
    if (!cleaned.ok)
      throw new ApiError(
        422,
        "content_blocked",
        cleaned.reason === "empty"
          ? "The message is empty."
          : "That message breaks the content rules for this consultation (sexual content or nudity). Rephrase it.",
      );
    this.takeToken(rec.agentBucket, "messages");
    const message = this.addMessage(rec, "agent", {
      role: "agent",
      kind: "text",
      body: cleaned.text,
      spoken: speakable(cleaned.text),
    });
    if (rec.presence === "thinking") this.setPresenceOn(rec, "idle");
    return message;
  }

  private takeToken(
    bucket: { take(): { ok: true } | { ok: false; retryAfterMs: number } },
    what: string,
  ) {
    const taken = bucket.take();
    if (!taken.ok)
      throw new ApiError(429, "rate_limited", `Too many ${what}. Slow down.`, {
        headers: {
          "Retry-After": String(
            Math.max(1, Math.ceil(taken.retryAfterMs / 1000)),
          ),
        },
      });
  }

  setPresence(id: string, state: Presence) {
    const rec = this.active(id);
    this.setPresenceOn(rec, state);
    return rec.presence;
  }

  private setPresenceOn(rec: SessionRecord<State, View>, state: Presence) {
    if (rec.presence === state) return;
    rec.presence = state;
    rec.emit("presence.changed", "agent", { presence: state }, this.now());
  }

  // --- Consent and photos ----------------------------------------------------------

  setConsent(id: string, input: { adult?: boolean; photoAnalysis?: boolean }) {
    const rec = this.active(id);
    rec.consent = {
      adult: input.adult ?? rec.consent.adult,
      photoAnalysis: input.photoAnalysis ?? rec.consent.photoAnalysis,
      at: this.now(),
      source: "client",
    };
    rec.emit(
      "consent.updated",
      "client",
      { consent: { ...rec.consent } },
      this.now(),
    );
    return rec.consent;
  }

  async addPhoto(id: string, bytes: Uint8Array): Promise<PhotoMeta> {
    const rec = this.active(id);
    if (!rec.consent.adult || !rec.consent.photoAnalysis)
      throw new ApiError(
        409,
        "consent_required",
        "Confirm you are 18 or older and agree to photo analysis before sharing a photo.",
      );
    if (rec.photos.size >= LIMITS.maxPhotos)
      throw new ApiError(
        409,
        "photo_limit",
        `You can share up to ${LIMITS.maxPhotos} photos per session.`,
      );
    let normalized;
    try {
      normalized = await normalizeImage(bytes, {
        maxUploadBytes: LIMITS.photoUploadBytes,
        maxSide: LIMITS.photoMaxSide,
        minShortSide: LIMITS.photoMinShortSide,
      });
    } catch (error) {
      if (error instanceof ApiError)
        rec.emit(
          "photo.rejected",
          "client",
          { code: error.code, message: error.message },
          this.now(),
        );
      throw error;
    }
    // The session may have ended while the photo was decoded.
    if (rec.phase !== "active")
      throw new ApiError(409, "session_ended", "This consultation has ended.");
    if (rec.imageBytes + normalized.jpeg.byteLength > LIMITS.sessionImageBytes)
      throw new ApiError(
        409,
        "photo_limit",
        "This session holds as many images as it can.",
      );
    const photoId = newId("pho");
    const meta: PhotoMeta = {
      id: photoId,
      at: this.now(),
      width: normalized.width,
      height: normalized.height,
      bytes: normalized.jpeg.byteLength,
    };
    rec.photos.set(photoId, {
      meta,
      jpeg: normalized.jpeg,
      sha256: normalized.sha256,
      providerFileId: null,
      providerFileAt: null,
    });
    rec.imageBytes += normalized.jpeg.byteLength;
    rec.emit("photo.added", "client", { photo: { ...meta } }, meta.at);
    this.addMessage(rec, "client", {
      role: "client",
      kind: "photo",
      body: "Shared a photo.",
      data: { photoId, width: meta.width, height: meta.height },
    });
    if (rec.ui.mediaRequest) {
      rec.ui.mediaRequest = null;
      this.announceUi(rec, "client");
    }
    return meta;
  }

  /** Deletes a photo and every image made from it. */
  deletePhoto(id: string, photoId: string) {
    const rec = this.active(id);
    const photo = rec.photos.get(photoId);
    if (!photo)
      throw new ApiError(
        404,
        "unknown_photo",
        "No such photo in this session.",
      );
    const gone = new Set<string>([photoId]);
    rec.photos.delete(photoId);
    rec.imageBytes -= photo.jpeg.byteLength;
    for (const [imageId, image] of rec.images)
      if (image.photoId === photoId) {
        gone.add(imageId);
        rec.images.delete(imageId);
        rec.imageBytes -= image.bytes.byteLength;
      }
    this.dropMedia(rec, gone, "client");
    rec.emit("photo.deleted", "client", { photoId }, this.now());
  }

  private dropMedia(
    rec: SessionRecord<State, View>,
    ids: ReadonlySet<string>,
    actor: Actor,
  ) {
    const next = structuredClone(rec.state);
    this.app.dropMedia(next, ids);
    this.commitState(rec, next, actor);
    this.refreshUi(rec, actor);
  }

  // --- UI ----------------------------------------------------------------------

  /** Recomputes available screens and announces the UI if it changed. */
  private refreshUi(rec: SessionRecord<State, View>, by: Actor) {
    const available = this.app.availableScreens(rec.state);
    if (JSON.stringify(available) !== JSON.stringify(rec.ui.available)) {
      rec.ui.available = available;
      if (!available.includes(rec.ui.screen)) {
        rec.ui.screen = available[0] ?? "chat";
        rec.ui.target = null;
      }
      this.announceUi(rec, by);
    }
  }

  private announceUi(rec: SessionRecord<State, View>, by: Actor) {
    rec.emit(
      "ui.changed",
      by,
      {
        ui: structuredClone(rec.ui) as UiState,
        by: by === "agent" || by === "client" ? by : "app",
      },
      this.now(),
    );
  }

  private applyUiPatch(
    rec: SessionRecord<State, View>,
    patch: UiPatch<View>,
    by: Actor,
  ) {
    const before = JSON.stringify(rec.ui);
    const ui = rec.ui;
    if (patch.screen !== undefined) ui.screen = patch.screen;
    if (patch.target !== undefined) ui.target = patch.target;
    if (patch.focus !== undefined) ui.focus = patch.focus;
    if (patch.following !== undefined) ui.following = patch.following;
    if (patch.mediaRequest !== undefined) ui.mediaRequest = patch.mediaRequest;
    if (patch.notice !== undefined) ui.notice = patch.notice;
    if (patch.nudge !== undefined) ui.nudge = patch.nudge;
    if (patch.view) ui.view = { ...ui.view, ...patch.view };
    ui.available = this.app.availableScreens(rec.state);
    // A pointer to a screen has done its job once the advisor has taken the
    // client there (unless this very change leaves a new one).
    if (patch.screen !== undefined && patch.nudge === undefined && ui.nudge) {
      const nudged = this.app.resolveTarget(rec.state, ui.nudge.target);
      if (nudged.ok && nudged.screen === ui.screen) ui.nudge = null;
    }
    if (JSON.stringify(ui) !== before) this.announceUi(rec, by);
  }

  /** Something the client did in the app. */
  uiEvent(id: string, event: UiEventInput) {
    const rec = this.active(id);
    const ui = rec.ui;
    switch (event.type) {
      case "navigate": {
        if (!ui.available.includes(event.screen))
          throw new ApiError(
            422,
            "unknown_target",
            `The ${event.screen} screen has no content.`,
            { details: { available: ui.available } },
          );
        ui.screen = event.screen;
        ui.target = null;
        ui.following = false;
        // A pointer to this screen has done its job.
        if (ui.nudge) {
          const nudged = this.app.resolveTarget(rec.state, ui.nudge.target);
          if (nudged.ok && nudged.screen === event.screen) ui.nudge = null;
        }
        break;
      }
      case "follow": {
        ui.following = true;
        if (ui.focus) {
          ui.screen = ui.focus.screen;
          ui.target = ui.focus.target;
        }
        ui.nudge = null;
        break;
      }
      case "focus": {
        const resolved = this.app.resolveTarget(rec.state, event.target);
        if (!resolved.ok)
          throw new ApiError(422, "unknown_target", resolved.message, {
            details: { valid: resolved.valid.slice(0, 60) },
          });
        ui.screen = resolved.screen;
        ui.target = event.target;
        ui.following = false;
        break;
      }
      case "view": {
        const parsed = this.app.viewSchema.safeParse(event.view);
        if (!parsed.success)
          throw new ApiError(
            422,
            "invalid_arguments",
            "That view change is not valid.",
            {
              details: parsed.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            },
          );
        ui.view = { ...ui.view, ...parsed.data };
        // Using the controls hands the screen to the client.
        ui.following = false;
        break;
      }
      case "capture":
        ui.capturing = event.open;
        break;
      case "dismiss":
        if (event.what === "notice") ui.notice = null;
        else if (event.what === "nudge") ui.nudge = null;
        else ui.mediaRequest = null;
        break;
      case "action": {
        rec.emit(
          "client.action",
          "client",
          { action: event.action, target: event.target ?? null },
          this.now(),
        );
        return rec.ui;
      }
    }
    this.announceUi(rec, "client");
    return rec.ui;
  }

  // --- Ending ------------------------------------------------------------------

  end(rec: SessionRecord<State, View>, reason: EndReason, actor: Actor) {
    if (rec.phase === "ended") return;
    const gone = new Set<string>([...rec.photos.keys(), ...rec.images.keys()]);
    rec.photos.clear();
    rec.images.clear();
    rec.imageBytes = 0;
    rec.replays.clear();
    const next = structuredClone(rec.state);
    this.app.dropMedia(next, gone);
    this.commitState(rec, next, actor);
    rec.phase = "ended";
    rec.endedAt = this.now();
    rec.endReason = reason;
    rec.presence = "idle";
    rec.ui.mediaRequest = null;
    rec.ui.capturing = false;
    rec.ui.available = this.app.availableScreens(rec.state);
    rec.emit("session.ended", actor, { reason }, rec.endedAt);
    rec.releaseWaiters();
  }

  endSession(id: string, role: ViewerRole) {
    const rec = this.get(id);
    this.end(rec, role, role === "host" ? "host" : role);
    return rec;
  }

  // --- Images ------------------------------------------------------------------

  /** A stored photo or result image, or 404. */
  image(rec: SessionRecord<State, View>, imageId: string) {
    const photo = rec.photos.get(imageId);
    if (photo) return { bytes: photo.jpeg, kind: "photo" as const };
    const image = rec.images.get(imageId);
    if (image) return { bytes: image.bytes, kind: "result" as const };
    throw new ApiError(404, "not_found", "That image is not available.");
  }

  private async storeImage(
    rec: SessionRecord<State, View>,
    bytes: Uint8Array,
    label: string,
    photoId: string | null,
  ): Promise<string | null> {
    try {
      const normalized = await normalizeImage(bytes, {
        maxUploadBytes: 12_000_000,
        maxSide: 1600,
      });
      if (rec.phase !== "active") return null;
      if (
        rec.imageBytes + normalized.jpeg.byteLength >
        LIMITS.sessionImageBytes
      )
        return null;
      const stored: StoredImage = {
        id: newId("img"),
        bytes: normalized.jpeg,
        label: label.slice(0, 120),
        photoId,
        at: this.now(),
      };
      rec.images.set(stored.id, stored);
      rec.imageBytes += normalized.jpeg.byteLength;
      return stored.id;
    } catch {
      return null;
    }
  }

  // --- Tools -------------------------------------------------------------------

  findTool(name: string): RegisteredTool<State, View> | undefined {
    return this.allTools().find((tool) => tool.name === name);
  }

  private context(rec: SessionRecord<State, View>): ToolContext<State, View> {
    const app = this.app;
    return {
      sessionId: rec.id,
      state: rec.state,
      ui: rec.ui,
      consent: rec.consent,
      engine: app.engineMode(),
      unitsRemaining: rec.unitsRemaining,
      photo: (photoId?: string): StoredPhoto | null => {
        const record = photoId
          ? rec.photos.get(photoId)
          : [...rec.photos.values()].at(-1);
        return record
          ? {
              id: record.meta.id,
              jpeg: record.jpeg,
              sha256: record.sha256,
              width: record.meta.width,
              height: record.meta.height,
              providerFileId: record.providerFileId,
              providerFileAt: record.providerFileAt,
            }
          : null;
      },
      hasPhoto: (photoId: string) => rec.photos.has(photoId),
      hasImage: (imageId: string) => rec.images.has(imageId),
      resolveTarget: (target: string) => app.resolveTarget(rec.state, target),
      availableScreens: () => app.availableScreens(rec.state),
      saveImage: (bytes, label, photoId) =>
        this.storeImage(rec, bytes, label, photoId),
      rememberProviderFile: (photoId, fileId) => {
        const record = rec.photos.get(photoId);
        if (record) {
          record.providerFileId = fileId;
          record.providerFileAt = this.now();
        }
      },
    };
  }

  /** Commits a new state and announces each top-level part that changed. */
  private commitState(
    rec: SessionRecord<State, View>,
    next: State,
    actor: Actor,
  ) {
    const changed: string[] = [];
    for (const key of Object.keys(next)) {
      if (JSON.stringify(next[key]) !== JSON.stringify(rec.state[key]))
        changed.push(key);
    }
    rec.state = next;
    for (const key of changed)
      rec.emit(
        "app.updated",
        actor,
        { kind: key, value: structuredClone(next[key]) },
        this.now(),
      );
    return changed;
  }

  /**
   * Calls a tool as the agent. Contract and transport problems throw an
   * ApiError (HTTP 4xx). Outcomes a tool reports itself (no photo yet, budget
   * spent, YouCam rejecting the photo) come back as ok:false in the response.
   */
  async callTool(
    id: string,
    name: string,
    rawArgs: unknown,
    options: ToolOptions = {},
  ): Promise<{ response: ToolResponse; replayed: boolean }> {
    const rec = this.active(id);
    const tool = this.findTool(name);
    if (!tool)
      throw new ApiError(404, "unknown_tool", `No tool named "${name}".`);
    this.takeToken(rec.toolBucket, "tool calls");
    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success)
      throw new ApiError(
        422,
        "invalid_arguments",
        `Invalid arguments for ${name}: ${parsed.error.issues
          .slice(0, 3)
          .map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("; ")}`,
        {
          details: parsed.error.issues.slice(0, 10).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      );
    const key = options.idempotencyKey;
    const hash = createHash("sha256")
      .update(`${name}:${JSON.stringify(parsed.data)}`)
      .digest("hex");
    if (key) {
      const prior = rec.replays.get(key);
      if (prior) {
        if (prior.hash !== hash)
          throw new ApiError(
            409,
            "idempotency_conflict",
            "That Idempotency-Key was already used with different arguments.",
          );
        return {
          response: (await prior.response) as ToolResponse,
          replayed: true,
        };
      }
    }
    const work = this.enqueue(rec, () => this.runTool(rec, tool, parsed.data));
    if (key) {
      rec.replays.set(key, { hash, response: work });
      if (rec.replays.size > LIMITS.idempotencyKeys) {
        const oldest = rec.replays.keys().next().value;
        if (oldest !== undefined) rec.replays.delete(oldest);
      }
    }
    return { response: await work, replayed: false };
  }

  /** Runs `job` after every earlier job of this session has finished. */
  private enqueue<T>(rec: SessionRecord<State, View>, job: () => Promise<T>) {
    const result = rec.toolQueue.then(job, job);
    rec.toolQueue = result.catch(() => undefined);
    return result;
  }

  private respond(
    rec: SessionRecord<State, View>,
    tool: string,
    callId: string,
    run: {
      ok: boolean;
      units: number;
      result: Record_;
      error?: ToolResponse["error"];
    },
  ): ToolResponse {
    return {
      ok: run.ok,
      tool,
      callId,
      units: run.units,
      result: run.result,
      ...(run.error ? { error: run.error } : {}),
      rev: rec.rev,
      unitsRemaining: rec.unitsRemaining,
    };
  }

  private async runTool(
    rec: SessionRecord<State, View>,
    tool: RegisteredTool<State, View>,
    args: unknown,
  ): Promise<ToolResponse> {
    const callId = newId("cal");
    if (rec.phase !== "active")
      throw new ApiError(409, "session_ended", "This consultation has ended.");
    const refuse = (code: string, message: string) =>
      this.respond(rec, tool.name, callId, {
        ok: false,
        units: 0,
        result: {},
        error: { code, message },
      });
    if (tool.needsPhoto) {
      if (!rec.consent.adult || !rec.consent.photoAnalysis)
        return refuse(
          "consent_required",
          "The client has not yet confirmed they are 18 or older and agreed to photo analysis. Ask for a selfie with ui_request_photo; the app asks for consent.",
        );
      if (!rec.photos.size)
        return refuse(
          "no_photo",
          "No photo yet. Ask the client to share a clear, front-facing selfie (call ui_request_photo).",
        );
    }
    if (tool.usesEngine && this.app.engineMode() === "unavailable")
      return refuse(
        "unavailable",
        "YouCam analysis is unavailable right now. Continue with general advice.",
      );
    const estimate = tool.units?.(args) ?? 0;
    if (estimate > rec.unitsRemaining)
      return refuse(
        "budget_exhausted",
        `This consultation has used its YouCam budget (${rec.unitsRemaining} units left, ${estimate} needed). Continue with advice based on earlier results.`,
      );
    rec.emit("tool.started", "agent", { callId, tool: tool.name }, this.now());
    let run: ToolRun<State, View>;
    try {
      run = await tool.run(this.context(rec), args);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "tool_crashed",
          tool: tool.name,
          error: error instanceof Error ? error.name : "Error",
        }),
      );
      run = {
        ok: false,
        result: {},
        error: {
          code: "tool_error",
          message: "That tool could not finish. Try again.",
          retryable: true,
        },
      };
    }
    // The session may have ended or expired while the tool worked.
    if (rec.phase !== "active") {
      rec.images.clear();
      return refuse(
        "session_ended",
        "The consultation ended during this call.",
      );
    }
    const units = run.ok
      ? Math.min(run.units ?? estimate, rec.unitsRemaining)
      : 0;
    if (run.entry)
      this.addMessage(rec, "app", {
        role: "tool",
        kind: run.entry.kind,
        body: run.entry.body,
        ...(run.entry.data ? { data: run.entry.data } : {}),
      });
    if (run.ok) {
      if (run.patch) {
        const next = structuredClone(rec.state);
        run.patch(next);
        this.commitState(rec, next, "app");
      }
      if (units) {
        rec.unitsUsed += units;
        rec.emit(
          "budget.updated",
          "app",
          {
            unitsTotal: rec.unitsTotal,
            unitsUsed: rec.unitsUsed,
            unitsRemaining: rec.unitsRemaining,
          },
          this.now(),
        );
      }
      this.applyUiPatch(rec, run.ui ?? {}, "agent");
    }
    rec.emit(
      "tool.completed",
      "app",
      {
        callId,
        tool: tool.name,
        ok: run.ok,
        units,
        ...(run.error ? { errorCode: run.error.code } : {}),
      },
      this.now(),
    );
    return this.respond(rec, tool.name, callId, {
      ok: run.ok,
      units,
      result: run.result,
      error: run.error,
    });
  }

  /**
   * The one entry point for an agent's tool calls, over HTTP or MCP: the tools
   * the runtime implements itself (say, set_presence, ...) and every tool of
   * the app go through the same validation.
   */
  async invoke(
    id: string,
    name: string,
    rawArgs: unknown,
    options: ToolOptions & { signal?: AbortSignal } = {},
  ): Promise<{ response: ToolResponse; replayed: boolean }> {
    const schema = RUNTIME_TOOLS.find((tool) => tool.name === name);
    if (!schema) return this.callTool(id, name, rawArgs, options);
    const rec = this.get(id);
    const parsed = schema.input.safeParse(rawArgs ?? {});
    if (!parsed.success)
      throw new ApiError(
        422,
        "invalid_arguments",
        `Invalid arguments for ${name}: ${parsed.error.issues
          .slice(0, 3)
          .map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("; ")}`,
        {
          details: parsed.error.issues.slice(0, 10).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      );
    const args = parsed.data as Record_;
    const done = (
      result: Record_,
      ok = true,
      error?: ToolResponse["error"],
    ) => ({
      response: {
        ok,
        tool: name,
        callId: newId("cal"),
        units: 0,
        result,
        ...(error ? { error } : {}),
        rev: rec.rev,
        unitsRemaining: rec.unitsRemaining,
      } satisfies ToolResponse,
      replayed: false,
    });
    switch (name) {
      case "say":
        try {
          const message = this.agentMessage(id, args.text);
          return done({ seq: message.seq, spoken: message.spoken });
        } catch (error) {
          if (error instanceof ApiError && error.code === "content_blocked")
            return done({}, false, {
              code: error.code,
              message: error.message,
            });
          throw error;
        }
      case "set_presence":
        return done({ presence: this.setPresence(id, args.state as Presence) });
      case "get_session_state":
        return done(
          this.compactState(rec, (args.messages as number | undefined) ?? 12),
        );
      case "wait_for_events": {
        const batch = await this.events(id, args.after_rev as number, {
          waitMs: ((args.timeout_seconds as number | undefined) ?? 20) * 1000,
          types: args.types as string[] | undefined,
          signal: options.signal,
        });
        return done({
          events: batch.events,
          rev: batch.rev,
          phase: batch.phase,
        });
      }
      case "end_session":
        this.active(id);
        this.end(rec, "agent", "agent");
        return done({ ended: true });
      default:
        throw new ApiError(404, "unknown_tool", `No tool named "${name}".`);
    }
  }

  // --- Events ------------------------------------------------------------------

  events(
    id: string,
    after: number,
    options: {
      waitMs?: number;
      types?: readonly string[];
      signal?: AbortSignal;
    } = {},
  ): Promise<EventBatch> {
    const rec = this.get(id);
    return rec.waitForEvents(after, options.waitMs ?? 0, {
      types: options.types,
      signal: options.signal,
    });
  }

  // --- Transcript --------------------------------------------------------------

  transcriptText(rec: SessionRecord<State, View>) {
    const clientName = rec.client.displayName ?? "Client";
    const stamp = (at: number) =>
      new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const who = (role: MessageRole) =>
      role === "client"
        ? clientName
        : role === "agent"
          ? rec.advisor.name
          : "App";
    const lines = [
      `${this.app.name}: consultation with ${rec.advisor.name}`,
      `Started ${stamp(rec.createdAt)}${rec.endedAt ? `, ended ${stamp(rec.endedAt)}` : ""}`,
      this.app.disclaimer,
      "",
    ];
    for (const message of rec.messages)
      lines.push(
        `[${stamp(message.at)}] ${who(message.role)}: ${message.body}`,
      );
    return lines.join("\n") + "\n";
  }
}
