import type { CaseSummary } from '@casetogether/shared';
import type { ObjectId } from 'mongodb';
import type { CaseDefinition } from '../../game-engine/types.js';
import type { RoomDocument } from '../rooms/persistence.js';
import type {
  GameSessionDocument,
  ProviderAttemptDocument,
  SessionActionReceiptDocument,
  SessionStateMutation,
} from './persistence.js';

export interface CaseRepository {
  listPublishedSummaries(): Promise<readonly CaseSummary[]>;
  findLatestPublished(caseId: string): Promise<CaseDefinition | null>;
  findPublishedVersion(caseId: string, caseVersion: string): Promise<CaseDefinition | null>;
}

export interface GameSessionRoomRepository {
  findById(roomId: ObjectId): Promise<RoomDocument | null>;
  findVisibleById(roomId: ObjectId, actorUserId: ObjectId): Promise<RoomDocument | null>;
  linkPreparedSession(input: {
    roomId: ObjectId;
    sessionId: ObjectId;
    actorUserId: ObjectId;
    expectedVersion: number;
    now: Date;
  }): Promise<RoomDocument | null>;
}

export interface ProviderReservationInput {
  sessionId: ObjectId;
  expectedVersion: number;
  attempt: ProviderAttemptDocument;
}

export interface ProviderSettlementInput {
  sessionId: ObjectId;
  attemptId: string;
  executionId: string;
  status: 'succeeded' | 'failed';
  settledAt: Date;
}

export interface CompleteStartInput {
  sessionId: ObjectId;
  clientRequestId: string;
  receipt: SessionActionReceiptDocument;
  now: Date;
}

export interface CompleteStartResult {
  session: GameSessionDocument;
  receiptAdded: boolean;
}

export interface GameSessionRepository {
  findById(sessionId: ObjectId): Promise<GameSessionDocument | null>;
  findByRoomId(roomId: ObjectId): Promise<GameSessionDocument | null>;
  insertPendingStart(session: GameSessionDocument): Promise<void>;
  replaceSupersededStart(session: GameSessionDocument): Promise<GameSessionDocument | null>;
  prepareStart(
    sessionId: ObjectId,
    clientRequestId: string,
    now: Date,
  ): Promise<GameSessionDocument | null>;
  completeStart(input: CompleteStartInput): Promise<CompleteStartResult | null>;
  supersedeStart(
    sessionId: ObjectId,
    clientRequestId: string,
    now: Date,
  ): Promise<GameSessionDocument | null>;
  commitState(
    sessionId: ObjectId,
    expectedVersion: number,
    mutation: SessionStateMutation,
  ): Promise<GameSessionDocument | null>;
  reserveProviderAttempt(input: ProviderReservationInput): Promise<GameSessionDocument | null>;
  settleProviderAttempt(input: ProviderSettlementInput): Promise<void>;
}

export class DuplicateGameSessionRoomError extends Error {
  constructor() {
    super('A game session already exists for this room');
    this.name = 'DuplicateGameSessionRoomError';
  }
}
