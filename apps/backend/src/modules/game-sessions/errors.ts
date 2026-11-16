import { createHash } from 'node:crypto';
import { VersionSchema, type ClientRequestId, type PublicUser } from '@casetogether/shared';
import { ObjectId } from 'mongodb';
import type { EngineError, GameEngineOperation } from '../../game-engine/types.js';
import { ApplicationError } from '../../application-error.js';

export function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function normalizeRequestId(clientRequestId: ClientRequestId | string): string {
  return clientRequestId.toLowerCase();
}

export function parseObjectId(value: string, unauthenticated = false): ObjectId {
  if (ObjectId.isValid(value)) {
    const parsed = new ObjectId(value);
    if (parsed.toHexString() === value.toLowerCase()) {
      return parsed;
    }
  }
  throw new ApplicationError(
    unauthenticated ? 'UNAUTHENTICATED' : 'NOT_FOUND',
    unauthenticated ? 'Authentication required' : 'Resource not found',
  );
}

export function actorObjectId(actor: PublicUser): ObjectId {
  return parseObjectId(actor.id, true);
}

export function receiptLookupKey(input: {
  actorUserId: ObjectId;
  operation: 'room:start' | GameEngineOperation | 'suspect:free_text';
  aggregateId: string;
  clientRequestId: string;
}): string {
  return sha256({
    actorUserId: input.actorUserId.toHexString(),
    operation: input.operation,
    aggregateId: input.aggregateId,
    clientRequestId: input.clientRequestId,
  });
}

export function applicationErrorFromEngine(error: EngineError): ApplicationError {
  return new ApplicationError(error.code, error.message, error.details);
}

export function versionConflict(currentVersion: number): ApplicationError {
  return new ApplicationError('VERSION_CONFLICT', 'Game version has changed', {
    currentVersion: VersionSchema.parse(currentVersion),
  });
}

export function idempotencyKeyReused(): ApplicationError {
  return new ApplicationError(
    'IDEMPOTENCY_KEY_REUSED',
    'clientRequestId was reused with a different payload',
  );
}

export function invalidStateTransition(): ApplicationError {
  return new ApplicationError(
    'INVALID_STATE_TRANSITION',
    'Game action is not allowed in the current state',
  );
}

export function operationInProgress(): ApplicationError {
  return new ApplicationError('OPERATION_IN_PROGRESS', 'Another start operation is in progress');
}

export function notFound(): ApplicationError {
  return new ApplicationError('NOT_FOUND', 'Resource not found');
}
