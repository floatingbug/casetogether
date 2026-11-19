import { systemClock, type Clock } from '../identity/clock.js';
import { SUPERSEDED_START_INTENT_RETENTION_MS } from './persistence.js';
import type {
  GameSessionRepository,
  GameSessionRoomRepository,
  StartIntentCleanupCandidate,
} from './repository.js';

export const START_INTENT_STALE_AFTER_MS = 15 * 60 * 1000;
export const START_INTENT_CLEANUP_BATCH_LIMIT = 100;
export const START_INTENT_CLEANUP_INTERVAL_MS = 60_000;

export interface StartIntentCleanupResult {
  scanned: number;
  superseded: number;
  restored: number;
  skippedLinked: number;
  skippedChanged: number;
  failed: number;
}

export type StartIntentCleanupPhase =
  | 'candidates'
  | 'room-check'
  | 'supersede'
  | 'verify'
  | 'restore'
  | 'disarm'
  | 'timer';

export interface StartIntentCleanupFailure {
  phase: StartIntentCleanupPhase;
  category: string;
}

/**
 * Structured, non-sensitive cleanup telemetry. It deliberately carries counters and an error
 * category only: never actor IDs, request IDs, room/session IDs, prompts or dialogue content.
 */
export interface StartIntentCleanupLogger {
  run(result: StartIntentCleanupResult): void;
  error(failure: StartIntentCleanupFailure): void;
}

const consoleLogger: StartIntentCleanupLogger = {
  run(result) {
    console.log(JSON.stringify({ event: 'start_intent_cleanup_run', ...result }));
  },
  error(failure) {
    console.error(JSON.stringify({ event: 'start_intent_cleanup_error', ...failure }));
  },
};

export interface StartIntentCleanupDependencies {
  sessions: GameSessionRepository;
  rooms: Pick<GameSessionRoomRepository, 'findById'>;
  clock?: Clock;
  logger?: StartIntentCleanupLogger;
  staleAfterMs?: number;
  batchLimit?: number;
  intervalMs?: number;
}

function classifyError(error: unknown): string {
  if (error instanceof Error) {
    const code = Reflect.get(error, 'code');
    return typeof code === 'number' ? `${error.name}:${String(code)}` : error.name;
  }
  return 'NonErrorThrown';
}

function isLinkedToSession(
  room: Awaited<ReturnType<GameSessionRoomRepository['findById']>>,
  sessionId: StartIntentCleanupCandidate['sessionId'],
): boolean {
  return room?.activeSessionId?.equals(sessionId) === true;
}

export class StartIntentCleanup {
  private readonly sessions: GameSessionRepository;
  private readonly rooms: Pick<GameSessionRoomRepository, 'findById'>;
  private readonly clock: Clock;
  private readonly logger: StartIntentCleanupLogger;
  private readonly staleAfterMs: number;
  private readonly batchLimit: number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(dependencies: StartIntentCleanupDependencies) {
    this.sessions = dependencies.sessions;
    this.rooms = dependencies.rooms;
    this.clock = dependencies.clock ?? systemClock;
    this.logger = dependencies.logger ?? consoleLogger;
    this.staleAfterMs = Math.max(1, dependencies.staleAfterMs ?? START_INTENT_STALE_AFTER_MS);
    this.batchLimit = Math.max(
      1,
      Math.min(
        dependencies.batchLimit ?? START_INTENT_CLEANUP_BATCH_LIMIT,
        START_INTENT_CLEANUP_BATCH_LIMIT,
      ),
    );
    this.intervalMs = Math.max(1, dependencies.intervalMs ?? START_INTENT_CLEANUP_INTERVAL_MS);
  }

  async runOnce(now: Date): Promise<StartIntentCleanupResult> {
    const result: StartIntentCleanupResult = {
      scanned: 0,
      superseded: 0,
      restored: 0,
      skippedLinked: 0,
      skippedChanged: 0,
      failed: 0,
    };
    const staleBefore = new Date(now.getTime() - this.staleAfterMs);
    let candidates: readonly StartIntentCleanupCandidate[];
    try {
      candidates = await this.sessions.findStaleStartIntentCandidates({
        staleBefore,
        limit: this.batchLimit,
      });
    } catch (error) {
      result.failed += 1;
      this.logFailure('candidates', error);
      this.logger.run(result);
      return result;
    }

    result.scanned = candidates.length;
    for (const candidate of candidates) {
      await this.cleanCandidate(candidate, now, result);
    }
    this.logger.run(result);
    return result;
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runScheduled();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private async runScheduled(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.runOnce(new Date(this.clock().getTime()));
    } catch (error) {
      this.logFailure('timer', error);
    } finally {
      this.running = false;
    }
  }

  /**
   * Safe ordering for every candidate:
   *
   * 1. Read the room directly from MongoDB before writing. Already linked sessions are never
   *    touched, regardless of the stale candidate projection.
   * 2. Supersede with a CAS on the observed status and creation time plus the "no room:start
   *    receipt" predicate. A competing start therefore wins instead of being overwritten.
   * 3. Read the room again after the write. A concurrent start may link the session between the
   *    candidate read and the supersede. In that case the previous intent status, updatedAt and
   *    deleteAfter are restored with a CAS bound to this exact supersede marker.
   *
   * Residual race: without a replica-set transaction, a start can still create the room link
   * after the final room read. Such a start cannot persist a room:start receipt because
   * completeStart requires status `prepared`, so the session stays a visible operational anomaly
   * rather than a finished game. The 15-minute TTL grace keeps the document readable for follow-up,
   * and a failed restore disarms the TTL deletion instead of silently deleting a linked session.
   * The start path is serialized per room within one backend instance; a second instance widens
   * this documented window. The invariant "never delete a document whose room points at it" is
   * enforced on the normal path and via the disarm safety valve.
   */
  private async cleanCandidate(
    candidate: StartIntentCleanupCandidate,
    now: Date,
    result: StartIntentCleanupResult,
  ): Promise<void> {
    let phase: StartIntentCleanupPhase = 'room-check';
    let supersedeWritten = false;
    try {
      const roomBefore = await this.rooms.findById(candidate.roomId);
      if (isLinkedToSession(roomBefore, candidate.sessionId)) {
        result.skippedLinked += 1;
        return;
      }

      phase = 'supersede';
      const superseded = await this.sessions.supersedeStaleStartIntent({
        sessionId: candidate.sessionId,
        expectedStatus: candidate.status,
        expectedCreatedAt: candidate.createdAt,
        now,
        deleteAfter: new Date(now.getTime() + SUPERSEDED_START_INTENT_RETENTION_MS),
      });
      if (superseded === null) {
        // Status, creation time or a receipt changed between the read and the write.
        result.skippedChanged += 1;
        return;
      }
      result.superseded += 1;
      supersedeWritten = true;

      phase = 'verify';
      const roomAfter = await this.rooms.findById(candidate.roomId);
      if (!isLinkedToSession(roomAfter, candidate.sessionId)) {
        return;
      }

      phase = 'restore';
      const restored = await this.sessions.restoreSupersededStartIntent({
        sessionId: candidate.sessionId,
        supersededAt: now,
        previousStatus: candidate.status,
        previousUpdatedAt: candidate.updatedAt,
        previousDeleteAfter: candidate.deleteAfter,
      });
      if (restored !== null) {
        result.restored += 1;
        return;
      }

      // The room links to this session but another writer changed the supersede marker. Never let
      // the TTL delete a linked document; surface the conflict for operational follow-up.
      phase = 'disarm';
      const disarmed = await this.sessions.clearStartIntentDeletion(candidate.sessionId, now);
      result.failed += 1;
      this.logger.error({
        phase,
        category: disarmed ? 'restore_conflict_disarmed' : 'restore_conflict',
      });
    } catch (error) {
      result.failed += 1;
      this.logFailure(phase, error);
      if (supersedeWritten) {
        // A failed verification cannot prove that the room is unlinked. Disarm the TTL deletion
        // on a best-effort basis so no possibly linked document is removed.
        try {
          const disarmed = await this.sessions.clearStartIntentDeletion(candidate.sessionId, now);
          this.logger.error({
            phase: 'disarm',
            category: disarmed ? 'error_path_disarmed' : 'error_path_disarm_missed',
          });
        } catch (disarmError) {
          this.logFailure('disarm', disarmError);
        }
      }
    }
  }

  private logFailure(phase: StartIntentCleanupPhase, error: unknown): void {
    this.logger.error({ phase, category: classifyError(error) });
  }
}
