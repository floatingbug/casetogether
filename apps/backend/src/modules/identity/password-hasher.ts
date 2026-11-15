import { randomBytes } from 'node:crypto';
import { hash as argon2Hash, parseOptions, verify as argon2Verify } from '@node-rs/argon2';

export const ARGON2_MEMORY_COST_KIB = 19_456;
export const ARGON2_TIME_COST = 2;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_OUTPUT_LENGTH_BYTES = 32;
export const ARGON2_SALT_LENGTH_BYTES = 16;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
  needsRehash(passwordHash: string): boolean;
}

export class Argon2PasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return argon2Hash(password, {
      memoryCost: ARGON2_MEMORY_COST_KIB,
      timeCost: ARGON2_TIME_COST,
      parallelism: ARGON2_PARALLELISM,
      outputLen: ARGON2_OUTPUT_LENGTH_BYTES,
      salt: randomBytes(ARGON2_SALT_LENGTH_BYTES),
    });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2Verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  needsRehash(passwordHash: string): boolean {
    if (!passwordHash.startsWith('$argon2id$v=19$')) {
      return true;
    }

    try {
      const parameters = parseOptions(passwordHash);
      return (
        parameters.memoryCost < ARGON2_MEMORY_COST_KIB ||
        parameters.timeCost < ARGON2_TIME_COST ||
        parameters.parallelism < ARGON2_PARALLELISM ||
        parameters.outputLen < ARGON2_OUTPUT_LENGTH_BYTES ||
        parameters.saltLen < ARGON2_SALT_LENGTH_BYTES
      );
    } catch {
      return true;
    }
  }
}
