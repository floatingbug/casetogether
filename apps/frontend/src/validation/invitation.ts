import { InvitationCodeSchema } from '@casetogether/shared';

export function parseInvitationInput(value: string) {
  return InvitationCodeSchema.safeParse(value.trim().toUpperCase());
}
