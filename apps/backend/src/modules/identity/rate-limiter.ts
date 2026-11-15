import { createHmac } from 'node:crypto';
import { ApplicationError } from '../../application-error.js';
import { systemClock, type Clock } from './clock.js';
import { derivePurposeKey } from './secret.js';

export const AUTH_IP_REQUEST_LIMIT = 10;
export const AUTH_IP_WINDOW_MS = 5 * 60 * 1000;
export const AUTH_ACCOUNT_FAILURE_LIMIT = 5;
export const AUTH_ACCOUNT_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

type AttemptOutcome = 'success' | 'failure';

export interface AuthAttempt {
  settle(outcome: AttemptOutcome): void;
}

interface IpBucket {
  count: number;
  resetAt: number;
}

interface PendingAttempt {
  id: number;
  startedAt: number;
}

interface AccountBucket {
  failures: number[];
  pending: PendingAttempt[];
}

export function keyedRateLimitHash(key: Buffer, purpose: string, value: string): string {
  return createHmac('sha256', key)
    .update('CaseTogether/auth-rate-limit/v1')
    .update('\0')
    .update(purpose)
    .update('\0')
    .update(value)
    .digest('base64url');
}

function positiveSecondsUntil(target: number, now: number): number {
  return Math.max(1, Math.ceil((target - now) / 1000));
}

function rateLimitError(retryAfterSeconds: number): ApplicationError {
  return new ApplicationError('RATE_LIMITED', 'Too many authentication attempts', {
    retryAfterSeconds,
  });
}

export class AuthRateLimiter {
  private readonly clock: Clock;
  private readonly key: Buffer;
  private readonly ipBuckets = new Map<string, IpBucket>();
  private readonly accountBuckets = new Map<string, AccountBucket>();
  private nextAttemptId = 1;
  private lastCleanupAt = 0;

  constructor(sessionSecret: string, clock: Clock = systemClock) {
    this.clock = clock;
    this.key = derivePurposeKey(sessionSecret, 'auth-rate-limit-keys/v1');
  }

  beginAccount(emailNormalized: string): AuthAttempt {
    const now = this.clock().getTime();
    this.cleanup(now);
    const accountKey = keyedRateLimitHash(this.key, 'account', emailNormalized);
    const accountBucket = this.currentAccountBucket(accountKey, now);

    const accountRetry = this.accountRetryAfter(accountBucket, now);
    if (accountRetry !== null) {
      throw rateLimitError(accountRetry);
    }

    const acceptedAccountBucket = accountBucket ?? { failures: [], pending: [] };
    const attemptId = this.nextAttemptId;
    this.nextAttemptId += 1;
    acceptedAccountBucket.pending.push({ id: attemptId, startedAt: now });
    this.accountBuckets.set(accountKey, acceptedAccountBucket);

    let settled = false;
    return {
      settle: (outcome) => {
        if (settled) {
          return;
        }
        settled = true;
        this.settleAccountAttempt(accountKey, attemptId, outcome);
      },
    };
  }

  consumeIp(ipAddress: string): void {
    const now = this.clock().getTime();
    this.cleanup(now);
    const key = keyedRateLimitHash(this.key, 'ip', ipAddress);
    const existing = this.currentIpBucket(key, now);
    const retryAfter = this.ipRetryAfter(existing, now);
    if (retryAfter !== null) {
      throw rateLimitError(retryAfter);
    }

    const bucket = existing ?? { count: 0, resetAt: now + AUTH_IP_WINDOW_MS };
    bucket.count += 1;
    this.ipBuckets.set(key, bucket);
  }

  private currentIpBucket(key: string, now: number): IpBucket | undefined {
    const bucket = this.ipBuckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.ipBuckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  private currentAccountBucket(key: string, now: number): AccountBucket | undefined {
    const bucket = this.accountBuckets.get(key);
    if (bucket === undefined) {
      return undefined;
    }

    bucket.failures = bucket.failures.filter(
      (failedAt) => failedAt + AUTH_ACCOUNT_FAILURE_WINDOW_MS > now,
    );
    bucket.pending = bucket.pending.filter(
      (attempt) => attempt.startedAt + AUTH_ACCOUNT_FAILURE_WINDOW_MS > now,
    );
    if (bucket.failures.length === 0 && bucket.pending.length === 0) {
      this.accountBuckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  private ipRetryAfter(bucket: IpBucket | undefined, now: number): number | null {
    if (bucket === undefined || bucket.count < AUTH_IP_REQUEST_LIMIT) {
      return null;
    }
    return positiveSecondsUntil(bucket.resetAt, now);
  }

  private accountRetryAfter(bucket: AccountBucket | undefined, now: number): number | null {
    if (bucket === undefined) {
      return null;
    }
    const timestamps = [...bucket.failures, ...bucket.pending.map((attempt) => attempt.startedAt)];
    if (timestamps.length < AUTH_ACCOUNT_FAILURE_LIMIT) {
      return null;
    }
    const firstRelevantAttempt = Math.min(...timestamps);
    return positiveSecondsUntil(firstRelevantAttempt + AUTH_ACCOUNT_FAILURE_WINDOW_MS, now);
  }

  private settleAccountAttempt(key: string, attemptId: number, outcome: AttemptOutcome): void {
    const now = this.clock().getTime();
    const bucket = this.accountBuckets.get(key);
    if (bucket !== undefined) {
      bucket.pending = bucket.pending.filter((attempt) => attempt.id !== attemptId);
      if (outcome === 'failure') {
        bucket.failures.push(this.clock().getTime());
      }
      if (bucket.failures.length === 0 && bucket.pending.length === 0) {
        this.accountBuckets.delete(key);
      }
      return;
    }

    if (outcome === 'failure') {
      this.accountBuckets.set(key, { failures: [now], pending: [] });
    }
  }

  private cleanup(now: number): void {
    if (now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastCleanupAt = now;

    for (const [key, bucket] of this.ipBuckets) {
      if (bucket.resetAt <= now) {
        this.ipBuckets.delete(key);
      }
    }
    for (const key of this.accountBuckets.keys()) {
      this.currentAccountBucket(key, now);
    }
  }
}
