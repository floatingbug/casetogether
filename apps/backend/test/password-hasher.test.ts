import { randomBytes } from 'node:crypto';
import { hash, parseOptions } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';
import {
  ARGON2_MEMORY_COST_KIB,
  ARGON2_OUTPUT_LENGTH_BYTES,
  ARGON2_PARALLELISM,
  ARGON2_SALT_LENGTH_BYTES,
  ARGON2_TIME_COST,
  Argon2PasswordHasher,
} from '../src/modules/identity/password-hasher.js';

const password = '  password with significant spaces  ';

describe('Argon2id password hashing', () => {
  it('uses independent 128-bit salts and the required versioned parameters', async () => {
    const hasher = new Argon2PasswordHasher();
    const first = await hasher.hash(password);
    const second = await hasher.hash(password);
    const parameters = parseOptions(first);

    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(parameters.memoryCost).toBe(ARGON2_MEMORY_COST_KIB);
    expect(parameters.timeCost).toBe(ARGON2_TIME_COST);
    expect(parameters.parallelism).toBe(ARGON2_PARALLELISM);
    expect(parameters.outputLen).toBe(ARGON2_OUTPUT_LENGTH_BYTES);
    expect(parameters.saltLen).toBe(ARGON2_SALT_LENGTH_BYTES);
    expect(first).not.toBe(second);
    expect(first.split('$')[4]).not.toBe(second.split('$')[4]);
    expect(hasher.needsRehash(first)).toBe(false);
  });

  it('verifies the exact password without trimming or Unicode normalization', async () => {
    const hasher = new Argon2PasswordHasher();
    const passwordHash = await hasher.hash(password);

    expect(await hasher.verify(passwordHash, password)).toBe(true);
    expect(await hasher.verify(passwordHash, password.trim())).toBe(false);
    expect(await hasher.verify(passwordHash, `${password}x`)).toBe(false);
  });

  it('marks weaker legacy parameters for rehash after a successful login', async () => {
    const hasher = new Argon2PasswordHasher();
    const legacyHash = await hash(password, {
      memoryCost: 8_192,
      timeCost: 1,
      parallelism: 1,
      outputLen: 16,
      salt: randomBytes(16),
    });

    expect(legacyHash).toContain('$argon2id$v=19$');
    expect(await hasher.verify(legacyHash, password)).toBe(true);
    expect(hasher.needsRehash(legacyHash)).toBe(true);
  });

  it('fails closed for malformed stored hashes without returning parser details', async () => {
    const hasher = new Argon2PasswordHasher();

    expect(await hasher.verify('not-a-password-hash', password)).toBe(false);
    expect(hasher.needsRehash('not-a-password-hash')).toBe(true);
  });
});
