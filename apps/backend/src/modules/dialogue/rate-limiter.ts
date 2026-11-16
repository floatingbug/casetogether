import { ApplicationError } from '../../application-error.js';
import type { Clock } from '../identity/clock.js';

interface WindowCounter {
  startedAt: number;
  count: number;
}

export class DialogueRateLimiter {
  private readonly catalogWindows = new Map<string, WindowCounter>();
  private readonly freeTextWindows = new Map<string, WindowCounter>();
  private readonly freeTextTotals = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  consumeCatalog(actorUserId: string, sessionId: string): void {
    this.consumeWindow(this.catalogWindows, `${actorUserId}:${sessionId}`, 30);
  }

  consumeFreeText(actorUserId: string, sessionId: string): void {
    const key = `${actorUserId}:${sessionId}`;
    this.consumeWindow(this.freeTextWindows, key, 5);
    const total = (this.freeTextTotals.get(key) ?? 0) + 1;
    if (total > 20) {
      throw new ApplicationError('RATE_LIMITED', 'Free-text dialogue limit reached', {
        retryAfterSeconds: 3600,
      });
    }
    this.freeTextTotals.set(key, total);
  }

  private consumeWindow(windows: Map<string, WindowCounter>, key: string, limit: number): void {
    const now = this.clock().getTime();
    const existing = windows.get(key);
    const current =
      existing !== undefined && now - existing.startedAt < 60_000
        ? existing
        : { startedAt: now, count: 0 };
    if (current.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.startedAt + 60_000 - now) / 1000));
      throw new ApplicationError('RATE_LIMITED', 'Dialogue rate limit reached', {
        retryAfterSeconds,
      });
    }
    current.count += 1;
    windows.set(key, current);
    if (windows.size > 1024) {
      for (const [candidate, value] of windows) {
        if (now - value.startedAt >= 60_000) {
          windows.delete(candidate);
        }
      }
    }
  }
}
