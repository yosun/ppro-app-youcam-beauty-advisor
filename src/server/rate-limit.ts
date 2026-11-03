// A token bucket: `capacity` actions per `perMs`, refilled continuously.
// Small and in-memory; each session holds its own buckets, so one noisy
// session cannot slow another.

export class Bucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly perMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  /** Takes one token. Returns the milliseconds to wait when there is none. */
  take(): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / this.perMs) * this.capacity,
    );
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    const missing = 1 - this.tokens;
    return {
      ok: false,
      retryAfterMs: Math.ceil((missing / this.capacity) * this.perMs),
    };
  }
}

/** Counts hits per key in a sliding window. For unauthenticated routes. */
export class WindowCounter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit. False means the key is over its limit. */
  hit(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter(
      (at) => now - at < this.windowMs,
    );
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.prune();
    return true;
  }

  private prune() {
    const now = this.now();
    for (const [key, times] of this.hits)
      if (!times.some((at) => now - at < this.windowMs)) this.hits.delete(key);
  }
}
