import { ClientRequestIdSchema, type ClientRequestId } from '@casetogether/shared';

export function newClientRequestId(): ClientRequestId {
  return ClientRequestIdSchema.parse(globalThis.crypto.randomUUID());
}
