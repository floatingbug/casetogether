import { CaseSummarySchema, type CaseSummary } from '@casetogether/shared';
import { MongoServerError, type ObjectId, type Collection, type Db, type Document } from 'mongodb';
import type { CaseDefinition } from '../../game-engine/types.js';
import { RoomDocumentSchema, type RoomDocument } from '../rooms/persistence.js';
import {
  CaseDefinitionDocumentSchema,
  GameSessionDocumentSchema,
  SUPERSEDED_START_INTENT_RETENTION_MS,
  StartIntentCleanupCandidateDocumentSchema,
  caseDefinitionFromDocument,
  type GameSessionDocument,
  type SessionStateMutation,
} from './persistence.js';
import type {
  CaseRepository,
  CompleteStartInput,
  FindStaleStartIntentCandidatesInput,
  GameSessionRepository,
  GameSessionRoomRepository,
  CompleteStartResult,
  ProviderReservationInput,
  ProviderSettlementInput,
  RestoreSupersededStartIntentInput,
  StartIntentCleanupCandidate,
  SupersedeStaleStartIntentInput,
} from './repository.js';
import { DuplicateGameSessionRoomError } from './repository.js';

function parseSession(value: unknown): GameSessionDocument {
  const parsed = GameSessionDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Invalid gameSessions persistence document');
  }
  return parsed.data;
}

const START_INTENT_CLEANUP_MAX_BATCH = 1000;

function parseStartIntentCleanupCandidate(value: unknown): StartIntentCleanupCandidate {
  const parsed = StartIntentCleanupCandidateDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Invalid gameSessions start-intent cleanup projection');
  }
  return {
    sessionId: parsed.data._id,
    roomId: parsed.data.roomId,
    status: parsed.data.startIntent.status,
    createdAt: parsed.data.startIntent.createdAt,
    updatedAt: parsed.data.updatedAt,
    deleteAfter: parsed.data.deleteAfter,
  };
}

function isDuplicateRoomError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export class MongoCaseRepository implements CaseRepository {
  private readonly cases: Collection;

  constructor(database: Db) {
    this.cases = database.collection('cases');
  }

  async listPublishedSummaries(): Promise<readonly CaseSummary[]> {
    const documents: unknown[] = await this.cases.find({ status: 'published' }).toArray();
    const latest = new Map<string, CaseDefinition>();
    for (const document of documents) {
      const definition = this.parseCase(document);
      const current = latest.get(definition.id);
      if (current === undefined || compareVersions(definition.version, current.version) > 0) {
        latest.set(definition.id, definition);
      }
    }
    return [...latest.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 100)
      .map((definition) => CaseSummarySchema.parse(definition.summary));
  }

  async findLatestPublished(caseId: string): Promise<CaseDefinition | null> {
    const documents: unknown[] = await this.cases
      .find({ slug: caseId, id: caseId, status: 'published' })
      .toArray();
    if (documents.length === 0) {
      return null;
    }
    const definitions = documents.map((document) => this.parseCase(document));
    definitions.sort((left, right) => compareVersions(right.version, left.version));
    return definitions[0] ?? null;
  }

  async findPublishedVersion(caseId: string, caseVersion: string): Promise<CaseDefinition | null> {
    const document: unknown = await this.cases.findOne({
      slug: caseId,
      id: caseId,
      version: caseVersion,
      status: { $in: ['published', 'retired'] },
    });
    return document === null ? null : this.parseCase(document);
  }

  private parseCase(value: unknown): CaseDefinition {
    const parsed = CaseDefinitionDocumentSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error('Invalid cases persistence document');
    }
    return caseDefinitionFromDocument(parsed.data);
  }
}

export class MongoGameSessionRoomRepository implements GameSessionRoomRepository {
  private readonly rooms: Collection;

  constructor(database: Db) {
    this.rooms = database.collection('rooms');
  }

  async findById(roomId: ObjectId): Promise<RoomDocument | null> {
    const document: unknown = await this.rooms.findOne({ _id: roomId });
    return document === null ? null : this.parseRoom(document);
  }

  async findVisibleById(roomId: ObjectId, actorUserId: ObjectId): Promise<RoomDocument | null> {
    const document: unknown = await this.rooms.findOne({
      _id: roomId,
      'members.userId': actorUserId,
    });
    return document === null ? null : this.parseRoom(document);
  }

  async linkPreparedSession(input: {
    roomId: ObjectId;
    sessionId: ObjectId;
    actorUserId: ObjectId;
    expectedVersion: number;
    now: Date;
  }): Promise<RoomDocument | null> {
    const document: unknown = await this.rooms.findOneAndUpdate(
      {
        _id: input.roomId,
        version: input.expectedVersion,
        status: 'ready',
        hostUserId: input.actorUserId,
        activeSessionId: null,
        members: {
          $elemMatch: { userId: input.actorUserId, role: 'host' },
        },
        expiresAt: { $gt: input.now },
        $expr: {
          $and: [{ $gte: [{ $size: '$members' }, 2] }, { $lte: [{ $size: '$members' }, 4] }],
        },
      },
      {
        $set: {
          status: 'in_progress',
          activeSessionId: input.sessionId,
          updatedAt: input.now,
          deleteAfter: null,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    );
    return document === null ? null : this.parseRoom(document);
  }

  private parseRoom(value: unknown): RoomDocument {
    const parsed = RoomDocumentSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error('Invalid rooms persistence document at game-session boundary');
    }
    return parsed.data;
  }
}

export class MongoGameSessionRepository implements GameSessionRepository {
  private readonly sessions: Collection;

  constructor(database: Db) {
    this.sessions = database.collection('gameSessions');
  }

  async findById(sessionId: ObjectId): Promise<GameSessionDocument | null> {
    const document: unknown = await this.sessions.findOne({ _id: sessionId });
    return document === null ? null : parseSession(document);
  }

  async findByRoomId(roomId: ObjectId): Promise<GameSessionDocument | null> {
    const document: unknown = await this.sessions.findOne({ roomId });
    return document === null ? null : parseSession(document);
  }

  async insertPendingStart(session: GameSessionDocument): Promise<void> {
    try {
      await this.sessions.insertOne(GameSessionDocumentSchema.parse(session));
    } catch (error) {
      if (isDuplicateRoomError(error)) {
        throw new DuplicateGameSessionRoomError();
      }
      throw error;
    }
  }

  async replaceSupersededStart(session: GameSessionDocument): Promise<GameSessionDocument | null> {
    const parsed = GameSessionDocumentSchema.parse(session);
    const update: Document = {
      roomId: parsed.roomId,
      startIntent: parsed.startIntent,
      roomStartedEvent: parsed.roomStartedEvent,
      caseId: parsed.caseId,
      caseVersion: parsed.caseVersion,
      phase: parsed.phase,
      version: parsed.version,
      engineState: parsed.engineState,
      dialogues: parsed.dialogues,
      events: parsed.events,
      actionReceipts: parsed.actionReceipts,
      aiUsage: parsed.aiUsage,
      startedAt: parsed.startedAt,
      finishedAt: parsed.finishedAt,
      updatedAt: parsed.updatedAt,
      deleteAfter: parsed.deleteAfter,
    };
    const document: unknown = await this.sessions.findOneAndUpdate(
      {
        _id: session._id,
        'startIntent.status': 'superseded',
        'actionReceipts.operation': { $ne: 'room:start' },
      },
      { $set: update },
      { returnDocument: 'after' },
    );
    return document === null ? null : parseSession(document);
  }

  async prepareStart(
    sessionId: ObjectId,
    clientRequestId: string,
    now: Date,
  ): Promise<GameSessionDocument | null> {
    const document: unknown = await this.sessions.findOneAndUpdate(
      {
        _id: sessionId,
        'startIntent.clientRequestId': clientRequestId,
        'startIntent.status': 'pending',
        'actionReceipts.operation': { $ne: 'room:start' },
      },
      {
        $set: {
          'startIntent.status': 'prepared',
          'startIntent.preparedAt': now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    );
    return document === null ? null : parseSession(document);
  }

  async completeStart(input: CompleteStartInput): Promise<CompleteStartResult | null> {
    const update: Document = {
      $push: { actionReceipts: input.receipt },
      $set: { updatedAt: input.now },
    };
    const document: unknown = await this.sessions.findOneAndUpdate(
      {
        _id: input.sessionId,
        'startIntent.clientRequestId': input.clientRequestId,
        'startIntent.status': 'prepared',
        'actionReceipts.lookupKey': { $ne: input.receipt.lookupKey },
      },
      update,
      { returnDocument: 'after' },
    );
    if (document !== null) {
      return { session: parseSession(document), receiptAdded: true };
    }

    const existing = await this.sessions.findOne({
      _id: input.sessionId,
      'startIntent.clientRequestId': input.clientRequestId,
      'startIntent.status': 'prepared',
      'actionReceipts.lookupKey': input.receipt.lookupKey,
    });
    return existing === null ? null : { session: parseSession(existing), receiptAdded: false };
  }

  async supersedeStart(
    sessionId: ObjectId,
    clientRequestId: string,
    now: Date,
  ): Promise<GameSessionDocument | null> {
    const document: unknown = await this.sessions.findOneAndUpdate(
      {
        _id: sessionId,
        'startIntent.clientRequestId': clientRequestId,
        'startIntent.status': { $in: ['pending', 'prepared'] },
        'actionReceipts.operation': { $ne: 'room:start' },
      },
      {
        $set: {
          'startIntent.status': 'superseded',
          'startIntent.supersededAt': now,
          updatedAt: now,
          deleteAfter: new Date(now.getTime() + SUPERSEDED_START_INTENT_RETENTION_MS),
        },
      },
      { returnDocument: 'after' },
    );
    return document === null ? null : parseSession(document);
  }

  async findStaleStartIntentCandidates(
    input: FindStaleStartIntentCandidatesInput,
  ): Promise<readonly StartIntentCleanupCandidate[]> {
    const limit = Math.max(1, Math.min(input.limit, START_INTENT_CLEANUP_MAX_BATCH));
    const documents: unknown[] = await this.sessions
      .find(
        {
          'startIntent.status': { $in: ['pending', 'prepared'] },
          'startIntent.createdAt': { $lte: input.staleBefore },
          // The receipt is the authoritative marker of a successfully linked and committed start.
          'actionReceipts.operation': { $ne: 'room:start' },
        },
        {
          projection: {
            _id: 1,
            roomId: 1,
            'startIntent.status': 1,
            'startIntent.createdAt': 1,
            updatedAt: 1,
            deleteAfter: 1,
          },
        },
      )
      .sort({ 'startIntent.createdAt': 1, _id: 1 })
      .limit(limit)
      .toArray();
    return documents.map(parseStartIntentCleanupCandidate);
  }

  async supersedeStaleStartIntent(
    input: SupersedeStaleStartIntentInput,
  ): Promise<GameSessionDocument | null> {
    const document: unknown = await this.sessions.findOneAndUpdate(
      {
        _id: input.sessionId,
        'startIntent.status': input.expectedStatus,
        'startIntent.createdAt': input.expectedCreatedAt,
        'actionReceipts.operation': { $ne: 'room:start' },
      },
      {
        $set: {
          'startIntent.status': 'superseded',
          'startIntent.supersededAt': input.now,
          updatedAt: input.now,
          deleteAfter: input.deleteAfter,
        },
      },
      { returnDocument: 'after' },
    );
    return document === null ? null : parseSession(document);
  }

  async restoreSupersededStartIntent(
    input: RestoreSupersededStartIntentInput,
  ): Promise<GameSessionDocument | null> {
    // The exact supersede marker keeps a concurrent newer cleanup/start write from being reverted.
    const document: unknown = await this.sessions.findOneAndUpdate(
      {
        _id: input.sessionId,
        'startIntent.status': 'superseded',
        'startIntent.supersededAt': input.supersededAt,
        'actionReceipts.operation': { $ne: 'room:start' },
      },
      {
        $set: {
          'startIntent.status': input.previousStatus,
          'startIntent.supersededAt': null,
          updatedAt: input.previousUpdatedAt,
          deleteAfter: input.previousDeleteAfter,
        },
      },
      { returnDocument: 'after' },
    );
    return document === null ? null : parseSession(document);
  }

  async clearStartIntentDeletion(sessionId: ObjectId, supersededAt: Date): Promise<boolean> {
    // Safety valve: if a linked session could not be restored, its TTL deletion is disarmed.
    const result = await this.sessions.updateOne(
      {
        _id: sessionId,
        'startIntent.status': 'superseded',
        'startIntent.supersededAt': supersededAt,
      },
      { $set: { deleteAfter: null } },
    );
    return result.matchedCount === 1;
  }

  async commitState(
    sessionId: ObjectId,
    expectedVersion: number,
    mutation: SessionStateMutation,
  ): Promise<GameSessionDocument | null> {
    const update: Document = {
      engineState: mutation.engineState,
      dialogues: mutation.dialogues,
      events: mutation.events,
      actionReceipts: mutation.actionReceipts,
      phase: mutation.phase,
      version: mutation.version,
      startedAt: mutation.startedAt,
      finishedAt: mutation.finishedAt,
      updatedAt: mutation.updatedAt,
      deleteAfter: mutation.deleteAfter,
    };
    const document: unknown = await this.sessions.findOneAndUpdate(
      {
        _id: sessionId,
        version: expectedVersion,
        phase: 'investigating',
        'startIntent.status': 'prepared',
      },
      { $set: update },
      { returnDocument: 'after' },
    );
    return document === null ? null : parseSession(document);
  }

  async reserveProviderAttempt(
    input: ProviderReservationInput,
  ): Promise<GameSessionDocument | null> {
    const update: Document = {
      $inc: { 'aiUsage.providerAttemptsReserved': 1 },
      $push: { 'aiUsage.attempts': input.attempt },
    };
    const document: unknown = await this.sessions.findOneAndUpdate(
      {
        _id: input.sessionId,
        phase: 'investigating',
        version: input.expectedVersion,
        'startIntent.status': 'prepared',
        'aiUsage.providerAttemptsReserved': { $lt: 60 },
        'aiUsage.attempts.attemptId': { $ne: input.attempt.attemptId },
      },
      update,
      { returnDocument: 'after' },
    );
    return document === null ? null : parseSession(document);
  }

  async settleProviderAttempt(input: ProviderSettlementInput): Promise<void> {
    await this.sessions.updateOne(
      {
        _id: input.sessionId,
        'aiUsage.attempts': {
          $elemMatch: {
            attemptId: input.attemptId,
            executionId: input.executionId,
            status: 'reserved',
          },
        },
      },
      {
        $set: {
          'aiUsage.attempts.$.status': input.status,
          'aiUsage.attempts.$.settledAt': input.settledAt,
        },
      },
    );
  }
}
