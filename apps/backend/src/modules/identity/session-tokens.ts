import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { derivePurposeKey } from './secret.js';

export const SESSION_ID_ENTROPY_BYTES = 32;
const ENCODED_SESSION_ID_LENGTH = 43;
const ENCODED_SIGNATURE_LENGTH = 43;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface SessionMaterial {
  cookieValue: string;
  sessionIdHash: string;
}

export class SessionTokenService {
  private readonly signingKey: Buffer;
  private readonly generateSessionId: () => Uint8Array;

  constructor(sessionSecret: string, generateSessionId: () => Uint8Array = () => randomBytes(32)) {
    this.signingKey = derivePurposeKey(sessionSecret, 'auth-session-cookie-hmac/v1');
    this.generateSessionId = generateSessionId;
  }

  create(): SessionMaterial {
    const sessionId = Buffer.from(this.generateSessionId());
    if (sessionId.length !== SESSION_ID_ENTROPY_BYTES) {
      throw new Error('Auth session ID generator must return exactly 32 bytes');
    }

    const encodedSessionId = sessionId.toString('base64url');
    const encodedSignature = this.sign(sessionId).toString('base64url');
    return {
      cookieValue: `${encodedSessionId}.${encodedSignature}`,
      sessionIdHash: this.hashSessionId(sessionId),
    };
  }

  sessionHashFromCookie(cookieValue: unknown): string | null {
    if (
      typeof cookieValue !== 'string' ||
      cookieValue.length !== ENCODED_SESSION_ID_LENGTH + 1 + ENCODED_SIGNATURE_LENGTH
    ) {
      return null;
    }

    const parts = cookieValue.split('.');
    const encodedSessionId = parts[0];
    const encodedSignature = parts[1];
    if (
      encodedSessionId === undefined ||
      encodedSignature === undefined ||
      parts.length !== 2 ||
      !BASE64URL_PATTERN.test(encodedSessionId) ||
      !BASE64URL_PATTERN.test(encodedSignature)
    ) {
      return null;
    }

    const sessionId = Buffer.from(encodedSessionId, 'base64url');
    const suppliedSignature = Buffer.from(encodedSignature, 'base64url');
    if (
      sessionId.length !== SESSION_ID_ENTROPY_BYTES ||
      sessionId.toString('base64url') !== encodedSessionId ||
      suppliedSignature.length !== this.signingKey.length ||
      suppliedSignature.toString('base64url') !== encodedSignature
    ) {
      return null;
    }

    const expectedSignature = this.sign(sessionId);
    if (!timingSafeEqual(expectedSignature, suppliedSignature)) {
      return null;
    }

    return this.hashSessionId(sessionId);
  }

  private sign(sessionId: Buffer): Buffer {
    return createHmac('sha256', this.signingKey)
      .update('CaseTogether/auth-session-id/v1')
      .update('\0')
      .update(sessionId)
      .digest();
  }

  private hashSessionId(sessionId: Buffer): string {
    return createHash('sha256')
      .update('CaseTogether/auth-session-storage/v1')
      .update('\0')
      .update(sessionId)
      .digest('hex');
  }
}
