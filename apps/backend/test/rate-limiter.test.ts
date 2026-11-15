import { describe, expect, it } from 'vitest';
import { ApplicationError } from '../src/application-error.js';
import { derivePurposeKey } from '../src/modules/identity/secret.js';
import {
  AUTH_ACCOUNT_FAILURE_WINDOW_MS,
  AUTH_IP_WINDOW_MS,
  AuthRateLimiter,
  keyedRateLimitHash,
} from '../src/modules/identity/rate-limiter.js';
import { MutableClock, TEST_SESSION_SECRET } from './support/auth-test-app.js';

function expectRateLimited(operation: () => void): ApplicationError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    if (error instanceof ApplicationError) {
      expect(error.code).toBe('RATE_LIMITED');
      return error;
    }
  }
  throw new Error('Expected RATE_LIMITED');
}

describe('authentication rate limits', () => {
  it('allows exactly ten IP requests per five-minute window', () => {
    const clock = new MutableClock();
    const limiter = new AuthRateLimiter(TEST_SESSION_SECRET, clock.read);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.consumeIp('192.0.2.10');
    }
    const blocked = expectRateLimited(() => limiter.consumeIp('192.0.2.10'));
    expect(blocked.details?.retryAfterSeconds).toBe(300);

    clock.advance(AUTH_IP_WINDOW_MS - 1_000);
    expectRateLimited(() => limiter.consumeIp('192.0.2.10'));
    clock.advance(1_000);
    limiter.consumeIp('192.0.2.10');
  });

  it('allows only five failures for an account key in fifteen minutes', () => {
    const clock = new MutableClock();
    const limiter = new AuthRateLimiter(TEST_SESSION_SECRET, clock.read);

    for (let failure = 0; failure < 5; failure += 1) {
      limiter.beginAccount('person@example.com').settle('failure');
    }
    const blocked = expectRateLimited(() => limiter.beginAccount('person@example.com'));
    expect(blocked.details?.retryAfterSeconds).toBe(AUTH_ACCOUNT_FAILURE_WINDOW_MS / 1000);

    clock.advance(AUTH_ACCOUNT_FAILURE_WINDOW_MS);
    limiter.beginAccount('person@example.com').settle('success');
  });

  it('reserves account slots against parallel failures and releases successful attempts', () => {
    const clock = new MutableClock();
    const limiter = new AuthRateLimiter(TEST_SESSION_SECRET, clock.read);
    const attempts = Array.from({ length: 5 }, () => limiter.beginAccount('person@example.com'));

    expectRateLimited(() => limiter.beginAccount('person@example.com'));
    attempts[0]?.settle('success');
    const accepted = limiter.beginAccount('person@example.com');
    accepted.settle('success');
    for (const attempt of attempts.slice(1)) {
      attempt.settle('success');
    }

    const successfulAttempts = new AuthRateLimiter(TEST_SESSION_SECRET, clock.read);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      successfulAttempts.beginAccount('person@example.com').settle('success');
    }
  });

  it('counts failures idempotently when an attempt is settled repeatedly', () => {
    const clock = new MutableClock();
    const limiter = new AuthRateLimiter(TEST_SESSION_SECRET, clock.read);
    const attempt = limiter.beginAccount('person@example.com');
    attempt.settle('failure');
    attempt.settle('failure');

    for (let failure = 0; failure < 4; failure += 1) {
      limiter.beginAccount('person@example.com').settle('failure');
    }
    expectRateLimited(() => limiter.beginAccount('person@example.com'));
  });

  it('stores only purpose-separated keyed hashes, not raw account/IP keys', () => {
    const key = derivePurposeKey(TEST_SESSION_SECRET, 'unit-test-purpose');
    const emailKey = keyedRateLimitHash(key, 'account', 'person@example.com');
    const ipKey = keyedRateLimitHash(key, 'ip', 'person@example.com');
    const otherAccount = keyedRateLimitHash(key, 'account', 'other@example.com');

    expect(emailKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(emailKey).not.toContain('person@example.com');
    expect(ipKey).not.toBe(emailKey);
    expect(otherAccount).not.toBe(emailKey);
  });
});
