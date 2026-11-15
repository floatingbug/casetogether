import { createHmac } from 'node:crypto';

export const MINIMUM_SESSION_SECRET_BYTES = 32;

export function assertValidSessionSecret(secret: string): void {
  if (Buffer.byteLength(secret, 'utf8') < MINIMUM_SESSION_SECRET_BYTES) {
    throw new Error('SESSION_SECRET must contain at least 32 bytes of random secret material');
  }
}

export function derivePurposeKey(sessionSecret: string, purpose: string): Buffer {
  assertValidSessionSecret(sessionSecret);
  return createHmac('sha256', sessionSecret)
    .update('CaseTogether/auth-secret-derivation/v1')
    .update('\0')
    .update(purpose)
    .digest();
}
