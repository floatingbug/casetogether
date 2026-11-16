import { ClientRequestIdSchema, type ClientRequestId } from '@casetogether/shared';

export function newClientRequestId(): ClientRequestId {
  if (typeof globalThis.crypto.randomUUID === 'function') {
    return ClientRequestIdSchema.parse(globalThis.crypto.randomUUID());
  }

  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error('Der sichere Zufallsgenerator lieferte zu wenige Bytes.');
  }
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return ClientRequestIdSchema.parse(uuid);
}
