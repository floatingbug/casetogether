import type { EngineErrorCode, EngineResult } from './types.js';

export function failure<Value>(
  code: EngineErrorCode,
  message: string,
  currentVersion?: number,
): EngineResult<Value> {
  if (currentVersion !== undefined) {
    return {
      ok: false,
      error: { code, message, details: { currentVersion } },
    };
  }
  return { ok: false, error: { code, message } };
}

export function versionConflict<Value>(currentVersion: number): EngineResult<Value> {
  return failure<Value>(
    'VERSION_CONFLICT',
    'Der Spielstand wurde zwischenzeitlich verändert.',
    currentVersion,
  );
}

export function invalidState<Value>(message: string): EngineResult<Value> {
  return failure<Value>('INVALID_STATE_TRANSITION', message);
}

export function questionUnavailable<Value>(): EngineResult<Value> {
  return failure<Value>(
    'QUESTION_NOT_AVAILABLE',
    'Diese Katalogfrage ist für diesen Verdächtigen oder Spieler nicht verfügbar.',
  );
}

export function notMember<Value>(): EngineResult<Value> {
  return failure<Value>('NOT_FOUND', 'Die Spielsession ist nicht verfügbar.');
}
