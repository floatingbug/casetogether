import { createHash } from 'node:crypto';
import type {
  CatalogQuestionRequest,
  FinalSubmissionRequest,
  SessionId,
} from '@casetogether/shared';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function deterministicId(prefix: string, parts: readonly string[]): string {
  return `${prefix}-${sha256(JSON.stringify(parts)).slice(0, 48)}`;
}

export function hashCatalogQuestionPayload(
  sessionId: SessionId,
  request: CatalogQuestionRequest,
): string {
  return sha256(
    JSON.stringify({
      sessionId,
      mode: request.mode,
      suspectId: request.suspectId,
      questionId: request.questionId,
      clientRequestId: request.clientRequestId,
      expectedVersion: request.expectedVersion,
    }),
  );
}

export function hashFinalSubmissionPayload(
  sessionId: SessionId,
  request: FinalSubmissionRequest,
): string {
  return sha256(
    JSON.stringify({
      sessionId,
      suspectId: request.suspectId,
      clientRequestId: request.clientRequestId,
      expectedVersion: request.expectedVersion,
    }),
  );
}
