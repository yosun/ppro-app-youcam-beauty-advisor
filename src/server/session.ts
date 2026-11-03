import { LIMITS } from "../protocol/constants.ts";
import { ApiError } from "../protocol/errors.ts";
import type {
  Actor,
  Consent,
  EndReason,
  EventMap,
  EventType,
  Message,
  PhotoMeta,
  Presence,
  PproEvent,
  SessionPhase,
  UiState,
} from "../protocol/types.ts";
import { Bucket } from "./rate-limit.ts";

// One consultation held in memory: its state, media, event log and limits.
// Photos and result images are never written to disk. They live here until
// the session ends, is expired by the sweeper, or the client deletes them.

export type StoredImage = {
  id: string;
  bytes: Buffer;
  label: string;
  photoId: string | null;
  at: number;
};

export type StoredPhotoRecord = {
  meta: PhotoMeta;
  jpeg: Buffer;
  sha256: string;
  providerFileId: string | null;
  providerFileAt: number | null;
};

export type EventBatch = {
  events: PproEvent[];
  /** The session's rev when `events` was chosen. Resume from here. */
  rev: number;
  phase: SessionPhase;
};

export type ToolReplay = {
  hash: string;
  response: Promise<unknown>;
};

export class SessionRecord<State, View> {
  readonly id: string;
  rev = 0;
  phase: SessionPhase = "active";
  readonly createdAt: number;
  expiresAt: number;
  endedAt: number | null = null;
  endReason: EndReason | null = null;

  advisor: { name: string; pronouns: string | null; persona: string | null };
  client: { displayName: string | null };
  consent: Consent;
  options: {
    agentVision: boolean;
    locale: string;
    hostOrigin: string | null;
    minutes: number;
  };
  unitsTotal: number;
  unitsUsed = 0;

  readonly photos = new Map<string, StoredPhotoRecord>();
  readonly images = new Map<string, StoredImage>();
  imageBytes = 0;

  readonly messages: Message[] = [];
  state: State;
  ui: UiState<View>;
  presence: Presence = "idle";

  readonly events: PproEvent[] = [];
  private readonly waiters = new Set<() => void>();

  /** Tool calls run one at a time, in arrival order. */
  toolQueue: Promise<unknown> = Promise.resolve();
  readonly replays = new Map<string, ToolReplay>();
  readonly toolBucket: Bucket;
  readonly clientBucket: Bucket;
  readonly agentBucket: Bucket;
  /** Minutes-left warnings already sent. */
  readonly warned = new Set<number>();
  lastActivity: number;

  constructor(init: {
    id: string;
    now: number;
    expiresAt: number;
    advisor: SessionRecord<State, View>["advisor"];
    client: SessionRecord<State, View>["client"];
    consent: Consent;
    options: SessionRecord<State, View>["options"];
    unitsTotal: number;
    state: State;
    ui: UiState<View>;
  }) {
    this.id = init.id;
    this.createdAt = init.now;
    this.lastActivity = init.now;
    this.expiresAt = init.expiresAt;
    this.advisor = init.advisor;
    this.client = init.client;
    this.consent = init.consent;
    this.options = init.options;
    this.unitsTotal = init.unitsTotal;
    this.state = init.state;
    this.ui = init.ui;
    this.toolBucket = new Bucket(LIMITS.toolCallsPerMinute, 60_000);
    this.clientBucket = new Bucket(LIMITS.messagesPerMinute, 60_000);
    this.agentBucket = new Bucket(LIMITS.messagesPerMinute, 60_000);
  }

  get unitsRemaining() {
    return Math.max(0, this.unitsTotal - this.unitsUsed);
  }

  /** Appends an event and wakes everyone waiting for one. */
  emit<K extends EventType>(
    type: K,
    actor: Actor,
    data: EventMap[K],
    at: number,
  ) {
    this.rev += 1;
    this.events.push({
      rev: this.rev,
      at,
      type,
      actor,
      data,
    } as PproEvent);
    if (this.events.length > LIMITS.eventBuffer) this.events.shift();
    for (const wake of [...this.waiters]) wake();
  }

  /**
   * Events newer than `after`, optionally only of some types. Throws 410 when
   * `after` is older than the buffer, so a caller knows to reread the session.
   */
  eventsAfter(after: number, types?: readonly string[]): PproEvent[] {
    const oldest = this.events[0]?.rev ?? this.rev + 1;
    if (after < oldest - 1)
      throw new ApiError(
        410,
        "events_expired",
        "Those events are no longer kept. Read the session and continue from its rev.",
        { details: { oldestRev: oldest, rev: this.rev } },
      );
    return this.events.filter(
      (event) => event.rev > after && (!types || types.includes(event.type)),
    );
  }

  /**
   * Resolves with new events, or an empty list after `timeoutMs`. The `rev`
   * and `phase` returned are those at the moment the events were chosen, in
   * the same step, so `rev` is a safe place to resume from: every matching
   * event up to it is in `events`, and none after it has been skipped.
   */
  async waitForEvents(
    after: number,
    timeoutMs: number,
    options: { types?: readonly string[]; signal?: AbortSignal } = {},
  ): Promise<EventBatch> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const events = this.eventsAfter(after, options.types);
      const remaining = deadline - Date.now();
      // Nothing newer will ever come once the session has ended.
      if (
        events.length ||
        this.phase === "ended" ||
        remaining <= 0 ||
        options.signal?.aborted
      )
        return { events, rev: this.rev, phase: this.phase };
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.waiters.delete(finish);
          options.signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, remaining);
        this.waiters.add(finish);
        options.signal?.addEventListener("abort", finish, { once: true });
      });
    }
  }

  /** Wakes waiters so they notice the session ended. */
  releaseWaiters() {
    for (const wake of [...this.waiters]) wake();
  }
}
