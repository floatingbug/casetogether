import { createHash } from 'node:crypto';

export interface DialogueExecutionKey {
  readonly actorUserId: string;
  readonly operation: string;
  readonly aggregateId: string;
  readonly clientRequestId: string;
}

export type DialogueExecutionPayload =
  | {
      readonly mode: 'catalog';
      readonly suspectId: string;
      readonly questionId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly mode: 'free_text';
      readonly suspectId: string;
      readonly questionText: string;
      readonly expectedVersion: number;
    };

export interface DialogueExecutionRequest {
  readonly key: DialogueExecutionKey;
  readonly payload: DialogueExecutionPayload;
}

export type DialogueExecutionSettlement<T> =
  | { readonly receipt: 'persisted'; readonly value: T }
  | { readonly receipt: 'absent'; readonly value: T };

export type DialogueCoordinatedResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: 'IDEMPOTENCY_KEY_REUSED' };

type Execution<T> = () => DialogueExecutionSettlement<T> | Promise<DialogueExecutionSettlement<T>>;

interface CompletedExecution {
  readonly payloadHash: string;
  readonly value: unknown;
}

interface InFlightExecution {
  readonly payloadHash: string;
  readonly promise: Promise<DialogueCoordinatedResult<unknown>>;
}

function digest(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function scopeHash(key: DialogueExecutionKey): string {
  return digest([key.actorUserId, key.operation, key.aggregateId, key.clientRequestId]);
}

function payloadHash(payload: DialogueExecutionPayload): string {
  if (payload.mode === 'catalog') {
    return digest([payload.mode, payload.suspectId, payload.questionId, payload.expectedVersion]);
  }
  return digest([payload.mode, payload.suspectId, payload.questionText, payload.expectedVersion]);
}

/**
 * Process-local coordination, not a receipt repository. Only a settlement marked `persisted`
 * is replay-cached by T009 after CAS. Failures/uncommitted outcomes are always evicted.
 */
export class DialogueExecutionCoordinator {
  readonly #completed = new Map<string, CompletedExecution>();
  readonly #inFlight = new Map<string, InFlightExecution>();
  readonly #maximumCompletedEntries: number;

  constructor(maximumCompletedEntries = 128) {
    if (!Number.isSafeInteger(maximumCompletedEntries) || maximumCompletedEntries < 1) {
      throw new RangeError('maximumCompletedEntries must be a positive safe integer');
    }
    this.#maximumCompletedEntries = maximumCompletedEntries;
  }

  #completedValue<T>(scope: string, hash: string): DialogueCoordinatedResult<T> | null {
    const completed = this.#completed.get(scope);
    if (completed === undefined) {
      return null;
    }
    if (completed.payloadHash !== hash) {
      return { ok: false, code: 'IDEMPOTENCY_KEY_REUSED' };
    }

    this.#completed.delete(scope);
    this.#completed.set(scope, completed);
    // The map stores one caller-selected result type per execution scope; external data is never cast.
    return { ok: true, value: completed.value as T };
  }

  #rememberSuccess(scope: string, hash: string, value: unknown): void {
    this.#completed.delete(scope);
    this.#completed.set(scope, { payloadHash: hash, value });
    while (this.#completed.size > this.#maximumCompletedEntries) {
      const oldest = this.#completed.keys().next();
      if (oldest.done) {
        break;
      }
      this.#completed.delete(oldest.value);
    }
  }

  execute<T>(
    request: DialogueExecutionRequest,
    execution: Execution<T>,
  ): Promise<DialogueCoordinatedResult<T>> {
    const scope = scopeHash(request.key);
    const hash = payloadHash(request.payload);
    const completed = this.#completedValue<T>(scope, hash);
    if (completed !== null) {
      return Promise.resolve(completed);
    }

    const existing = this.#inFlight.get(scope);
    if (existing !== undefined) {
      if (existing.payloadHash !== hash) {
        return Promise.resolve({ ok: false, code: 'IDEMPOTENCY_KEY_REUSED' });
      }
      // The erased in-flight entry was created by this same generic execution path.
      return existing.promise as Promise<DialogueCoordinatedResult<T>>;
    }

    const attempt = Promise.resolve()
      .then(execution)
      .then((settlement): DialogueCoordinatedResult<T> => {
        if (settlement.receipt === 'persisted') {
          this.#rememberSuccess(scope, hash, settlement.value);
        }
        return { ok: true, value: settlement.value };
      });

    const tracked: Promise<DialogueCoordinatedResult<T>> = attempt.finally(() => {
      const current = this.#inFlight.get(scope);
      const erasedTracked: Promise<DialogueCoordinatedResult<unknown>> = tracked;
      if (current?.promise === erasedTracked) {
        this.#inFlight.delete(scope);
      }
    });
    const erasedTracked: Promise<DialogueCoordinatedResult<unknown>> = tracked;
    this.#inFlight.set(scope, { payloadHash: hash, promise: erasedTracked });
    return tracked;
  }
}
