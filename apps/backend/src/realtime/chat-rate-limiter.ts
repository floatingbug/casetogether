import { ApplicationError } from '../application-error.js';
import { systemClock, type Clock } from '../modules/identity/clock.js';

export const CHAT_REQUEST_LIMIT = 10;
export const CHAT_RATE_WINDOW_MS = 10 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

interface ChatBucket {
  count: number;
  resetAt: number;
}

export class ChatRateLimiter {
  private readonly clock: Clock;
  private readonly buckets = new Map<string, ChatBucket>();
  private lastCleanupAt = 0;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  consume(userId: string, roomId: string): void {
    const now = this.clock().getTime();
    this.cleanup(now);
    const key = `${userId}\0${roomId}`;
    const existing = this.buckets.get(key);
    if (existing !== undefined && existing.resetAt <= now) {
      this.buckets.delete(key);
    }
    const current = this.buckets.get(key);
    if (current !== undefined && current.count >= CHAT_REQUEST_LIMIT) {
      throw new ApplicationError('RATE_LIMITED', 'Too many chat messages', {
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      });
    }

    const bucket = current ?? { count: 0, resetAt: now + CHAT_RATE_WINDOW_MS };
    bucket.count += 1;
    this.buckets.set(key, bucket);
  }

  private cleanup(now: number): void {
    if (now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastCleanupAt = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
