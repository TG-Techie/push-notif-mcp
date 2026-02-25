/**
 * Token bucket rate limiter.
 *
 * Bucket starts full at `capacity`. Each call to `consume()` removes one token.
 * Tokens refill one at a time, one per `refillIntervalMs` milliseconds,
 * up to `capacity`. When the bucket is empty, `consume()` returns false.
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private lastRefillTime: number;

  constructor(capacity: number, refillIntervalMs: number) {
    this.capacity = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.tokens = capacity;
    this.lastRefillTime = Date.now();
  }

  /**
   * Attempt to consume one token from the bucket.
   * Returns true if a token was available (notification may proceed).
   * Returns false if the bucket is empty (notification should be dropped).
   *
   * When returning false, also returns `nextRefillMs` — the number of
   * milliseconds until the next token becomes available.
   */
  consume(): { allowed: true } | { allowed: false; nextRefillMs: number } {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true };
    }

    const elapsed = Date.now() - this.lastRefillTime;
    const nextRefillMs = Math.max(0, this.refillIntervalMs - elapsed);
    return { allowed: false, nextRefillMs };
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;

    if (elapsed < this.refillIntervalMs) {
      return;
    }

    const tokensToAdd = Math.floor(elapsed / this.refillIntervalMs);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
      // Advance lastRefillTime by the exact number of intervals consumed,
      // not to `now`, to avoid drift.
      this.lastRefillTime += tokensToAdd * this.refillIntervalMs;
    }
  }
}
