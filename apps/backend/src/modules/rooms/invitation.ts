import { createHash, randomBytes } from 'node:crypto';
import { InvitationCodeSchema } from '@casetogether/shared';

export const INVITATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITATION_CHARACTERS = 12;
export const INVITATION_TTL_MS = 60 * 60 * 1000;
export const LOBBY_TTL_MS = 24 * 60 * 60 * 1000;

export type InvitationCodeGenerator = () => string;

function validateCode(code: string): string {
  const result = InvitationCodeSchema.safeParse(code);
  if (!result.success) {
    throw new Error('Invitation code generator produced an invalid code');
  }
  return result.data;
}

export const generateInvitationCode: InvitationCodeGenerator = () => {
  const canonicalCharacters: string[] = [];
  for (const byte of randomBytes(INVITATION_CHARACTERS)) {
    const character = INVITATION_ALPHABET[byte & 0x1f];
    if (character === undefined) {
      throw new Error('Invitation code alphabet is inconsistent');
    }
    canonicalCharacters.push(character);
  }
  const canonical = canonicalCharacters.join('');
  return validateCode(`${canonical.slice(0, 4)}-${canonical.slice(4, 8)}-${canonical.slice(8)}`);
};

export function canonicalizeInvitationCode(code: string): string {
  return validateCode(code).replaceAll('-', '').toUpperCase();
}

export function hashInvitationCode(canonicalCode: string): string {
  return createHash('sha256').update(canonicalCode, 'utf8').digest('hex');
}
