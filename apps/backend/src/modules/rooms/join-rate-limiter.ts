import { ApplicationError } from '../../application-error.js';
import { systemClock, type Clock } from '../identity/clock.js';

export const ROOM_JOIN_USER_LIMIT = 10;
export const ROOM_JOIN_USER_WINDOW_MS = 5 * 60 * 1000;
export const ROOM_JOIN_IP_LIMIT = 50;
export const ROOM_JOIN_IP_WINDOW_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

interface FixedWindowBucket {
  count: number;
  resetAt: number;
}

export class JoinRateLimiter {
  private readonly clock: Clock;
  private readonly userBuckets = new Map<string, FixedWindowBucket>();
  private readonly ipBuckets = new Map<string, FixedWindowBucket>();
  private lastCleanupAt = 0;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  consumeUser(userId: string): void {
    this.consume(
      this.userBuckets,
      `user:${userId}`,
      ROOM_JOIN_USER_LIMIT,
      ROOM_JOIN_USER_WINDOW_MS,
    );
  }

  consumeIp(ipAddress: string): void {
    this.consume(this.ipBuckets, `ip:${ipAddress}`, ROOM_JOIN_IP_LIMIT, ROOM_JOIN_IP_WINDOW_MS);
  }

  private consume(
    buckets: Map<string, FixedWindowBucket>,
    key: string,
    limit: number,
    windowMs: number,
  ): void {
    const now = this.clock().getTime();
    this.cleanup(now);
    const current = buckets.get(key);
    const bucket =
      current === undefined || current.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : current;
    if (bucket.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      throw new ApplicationError('RATE_LIMITED', 'Too many room join attempts', {
        retryAfterSeconds,
      });
    }
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  private cleanup(now: number): void {
    if (now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastCleanupAt = now;
    for (const buckets of [this.userBuckets, this.ipBuckets]) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(key);
        }
      }
    }
  }
}
