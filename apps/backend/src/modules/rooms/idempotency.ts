import { createHash } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import type { RoomOperation } from './persistence.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function normalizeClientRequestId(clientRequestId: string): string {
  return clientRequestId.toLowerCase();
}

export function createRoomPayloadHash(clientRequestId: string): string {
  return sha256(JSON.stringify({ operation: 'create', clientRequestId }));
}

export function joinRoomPayloadHash(clientRequestId: string, canonicalCode: string): string {
  return sha256(JSON.stringify({ operation: 'join', clientRequestId, code: canonicalCode }));
}

export function versionedRoomPayloadHash(
  operation: 'rotate' | 'leave',
  roomId: ObjectId,
  clientRequestId: string,
  expectedVersion: number,
): string {
  return sha256(
    JSON.stringify({
      operation,
      roomId: roomId.toHexString(),
      clientRequestId,
      expectedVersion,
    }),
  );
}

export function roomReceiptLookupKey(
  actorUserId: ObjectId,
  operation: RoomOperation,
  aggregateId: string,
  clientRequestId: string,
): string {
  return sha256(
    JSON.stringify({
      actorUserId: actorUserId.toHexString(),
      operation,
      aggregateId,
      clientRequestId,
    }),
  );
}
