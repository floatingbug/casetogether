import { describe, expect, it } from 'vitest';
import { SessionTokenService } from '../src/modules/identity/session-tokens.js';

const testSecret = 'session-token-unit-test-secret-not-for-production';
const fixedId = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

function tokenParts(cookieValue: string): { id: Buffer; signature: Buffer } {
  const parts = cookieValue.split('.');
  const encodedId = parts[0];
  const encodedSignature = parts[1];
  if (encodedId === undefined || encodedSignature === undefined || parts.length !== 2) {
    throw new Error('Expected a signed session cookie');
  }
  return {
    id: Buffer.from(encodedId, 'base64url'),
    signature: Buffer.from(encodedSignature, 'base64url'),
  };
}

describe('signed random auth sessions', () => {
  it('uses a 256-bit ID, HMAC-SHA256 and a separate persisted hash projection', () => {
    const service = new SessionTokenService(testSecret, () => fixedId);
    const material = service.create();
    const parts = tokenParts(material.cookieValue);

    expect(parts.id).toHaveLength(32);
    expect(parts.signature).toHaveLength(32);
    expect(material.sessionIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(material.sessionIdHash).not.toContain(parts.id.toString('base64url'));
    expect(material.sessionIdHash).not.toContain(parts.signature.toString('base64url'));
    expect(service.sessionHashFromCookie(material.cookieValue)).toBe(material.sessionIdHash);
  });

  it('generates independent random session cookies with the production CSPRNG path', () => {
    const service = new SessionTokenService(testSecret);
    const first = service.create();
    const second = service.create();

    expect(first.cookieValue).not.toBe(second.cookieValue);
    expect(first.sessionIdHash).not.toBe(second.sessionIdHash);
    expect(tokenParts(first.cookieValue).id).toHaveLength(32);
  });

  it('rejects a changed signature and signatures from another secret', () => {
    const service = new SessionTokenService(testSecret, () => fixedId);
    const otherService = new SessionTokenService(
      'a-different-session-token-test-secret-not-for-production',
      () => fixedId,
    );
    const cookieValue = service.create().cookieValue;
    const last = cookieValue.at(-1);
    const tampered = `${cookieValue.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;

    expect(service.sessionHashFromCookie(tampered)).toBeNull();
    expect(otherService.sessionHashFromCookie(cookieValue)).toBeNull();
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'short.cookie',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%24.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ])('rejects malformed cookie input %j without a database lookup', (cookieValue) => {
    const service = new SessionTokenService(testSecret, () => fixedId);
    expect(service.sessionHashFromCookie(cookieValue)).toBeNull();
  });

  it('does not accept an injected generator with insufficient entropy bytes', () => {
    const service = new SessionTokenService(testSecret, () => new Uint8Array(16));
    expect(() => service.create()).toThrow(/32 bytes/);
  });
});
