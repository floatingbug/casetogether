import { createHash, randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { InvitationCodeSchema } from '@casetogether/shared';
import {
  createRoomPayloadHash,
  joinRoomPayloadHash,
  roomReceiptLookupKey,
  versionedRoomPayloadHash,
} from '../src/modules/rooms/idempotency.js';
import {
  canonicalizeInvitationCode,
  generateInvitationCode,
  hashInvitationCode,
  INVITATION_ALPHABET,
  INVITATION_CHARACTERS,
} from '../src/modules/rooms/invitation.js';
import {
  JoinRateLimiter,
  ROOM_JOIN_IP_LIMIT,
  ROOM_JOIN_USER_LIMIT,
  ROOM_JOIN_USER_WINDOW_MS,
} from '../src/modules/rooms/join-rate-limiter.js';
import { MutableClock, TEST_NOW } from './support/auth-test-app.js';
import { TEST_CODE_1, TEST_CODE_2 } from './support/rooms-test-app.js';

describe('room invitation generation and hashing', () => {
  it('uses the exact 32-character alphabet and twelve unbiased CSPRNG byte selections', () => {
    expect(INVITATION_ALPHABET).toHaveLength(32);
    expect(new Set(INVITATION_ALPHABET).size).toBe(32);
    expect(INVITATION_CHARACTERS).toBe(12);
    for (let index = 0; index < 40; index += 1) {
      expect(InvitationCodeSchema.safeParse(generateInvitationCode()).success).toBe(true);
    }
  });

  it('hashes only the uppercase ungrouped canonical code with SHA-256', () => {
    const canonical = canonicalizeInvitationCode(TEST_CODE_1);
    expect(canonical).toBe('ABCDEFGHJKLM');
    expect(hashInvitationCode(canonical)).toBe(
      createHash('sha256').update('ABCDEFGHJKLM', 'utf8').digest('hex'),
    );
    expect(hashInvitationCode(canonical)).toHaveLength(64);
    expect(hashInvitationCode(canonical)).not.toContain(TEST_CODE_1);
  });

  it('rejects codes outside the frozen transport alphabet', () => {
    expect(() => canonicalizeInvitationCode('IIII-OOOO-0000')).toThrow(
      'Invitation code generator produced an invalid code',
    );
  });
});

describe('room idempotency hashes', () => {
  it('binds every scope and payload component without storing plaintext invitation material in keys', () => {
    const actor = new ObjectId();
    const room = new ObjectId();
    const request = randomUUID().toLowerCase();
    const createHash = createRoomPayloadHash(request);
    const joinHash = joinRoomPayloadHash(request, canonicalizeInvitationCode(TEST_CODE_1));
    const otherJoinHash = joinRoomPayloadHash(request, canonicalizeInvitationCode(TEST_CODE_2));
    expect(createHash).toMatch(/^[a-f0-9]{64}$/);
    expect(joinHash).not.toBe(otherJoinHash);
    expect(versionedRoomPayloadHash('rotate', room, request, 1)).not.toBe(
      versionedRoomPayloadHash('rotate', room, request, 2),
    );
    expect(roomReceiptLookupKey(actor, 'join', room.toHexString(), request)).not.toBe(
      roomReceiptLookupKey(actor, 'rotate', room.toHexString(), request),
    );
    expect(roomReceiptLookupKey(actor, 'join', room.toHexString(), request)).not.toContain(
      TEST_CODE_1,
    );
  });
});

describe('room join rate limits', () => {
  it('counts synchronous attempts against the ten-per-user budget and expires deterministically', () => {
    const clock = new MutableClock(TEST_NOW);
    const limiter = new JoinRateLimiter(clock.read);
    for (let attempt = 0; attempt < ROOM_JOIN_USER_LIMIT; attempt += 1) {
      limiter.consumeUser('user-a');
    }
    expect(() => limiter.consumeUser('user-a')).toThrowError(
      expect.objectContaining({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 300 } }),
    );
    expect(() => limiter.consumeUser('user-b')).not.toThrow();
    clock.advance(ROOM_JOIN_USER_WINDOW_MS);
    expect(() => limiter.consumeUser('user-a')).not.toThrow();
  });

  it('enforces the independent fifty-per-hour IP budget including pending requests', () => {
    const limiter = new JoinRateLimiter(new MutableClock().read);
    for (let attempt = 0; attempt < ROOM_JOIN_IP_LIMIT; attempt += 1) {
      limiter.consumeIp('127.0.0.1');
    }
    expect(() => limiter.consumeIp('127.0.0.1')).toThrowError(
      expect.objectContaining({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 3600 } }),
    );
    expect(() => limiter.consumeIp('127.0.0.2')).not.toThrow();
  });
});
