import { createHash } from 'node:crypto';
import {
  CaseIdSchema,
  ClientRequestIdSchema,
  CaseResolutionSchema,
  CaseSummarySchema,
  CaseVersionSchema,
  ClueIdSchema,
  ClueSchema,
  DialogueModeSchema,
  EventIdSchema,
  FinalSubmissionSchema,
  GameEventSchema,
  GamePhaseSchema,
  GameResultSchema,
  PublicSuspectSchema,
  QuestionIdSchema,
  RoomIdSchema,
  RoomMemberSchema,
  ServerIsoDateTimeSchema,
  SessionIdSchema,
  SuspectDialogueSchema,
  SuspectIdSchema,
  UserIdSchema,
  VersionSchema,
  type GameEvent,
} from '@casetogether/shared';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import type {
  ActionReceipt,
  CaseDefinition,
  GameEngineOperation,
  GameEngineState,
  StoredClue,
  StoredDialogue,
  StoredGameEvent,
} from '../../game-engine/types.js';

export const GAME_SESSION_SCHEMA_VERSION = 1;
export const PROVIDER_ATTEMPT_LIMIT = 60;
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const visibilitySchema = z.enum(['room', 'actor']);

export const StartIntentDocumentSchema = z
  .object({
    actorUserId: z.instanceof(ObjectId),
    operation: z.literal('room:start'),
    roomId: z.instanceof(ObjectId),
    clientRequestId: ClientRequestIdSchema,
    payloadHash: sha256HexSchema,
    expectedRoomVersion: VersionSchema,
    caseId: CaseIdSchema,
    caseVersion: CaseVersionSchema,
    status: z.enum(['pending', 'prepared', 'superseded']),
    createdAt: z.date(),
    preparedAt: z.date().nullable(),
    supersededAt: z.date().nullable(),
  })
  .strict();
export type StartIntentDocument = z.infer<typeof StartIntentDocumentSchema>;

export const SessionActionReceiptDocumentSchema = z
  .object({
    actorUserId: UserIdSchema,
    operation: z.enum(['room:start', 'suspect:catalog', 'suspect:free_text', 'game:final']),
    aggregateId: SessionIdSchema,
    clientRequestId: ClientRequestIdSchema,
    payloadHash: sha256HexSchema,
    lookupKey: sha256HexSchema,
    eventId: EventIdSchema,
    createdAt: z.date(),
  })
  .strict();
export type SessionActionReceiptDocument = z.infer<typeof SessionActionReceiptDocumentSchema>;

const StoredDialogueDocumentSchema = z
  .object({
    actorUserId: UserIdSchema,
    visibility: visibilitySchema,
    dialogue: SuspectDialogueSchema,
  })
  .strict();

const StoredClueDocumentSchema = z
  .object({
    actorUserId: UserIdSchema.nullable(),
    visibility: visibilitySchema,
    clue: ClueSchema,
  })
  .strict();

const RecipientGameEventDocumentSchema = z
  .object({
    recipientUserId: UserIdSchema,
    event: GameEventSchema.nullable(),
  })
  .strict();

const StoredGameEventDocumentSchema = z
  .object({
    eventId: EventIdSchema,
    deliveries: z.array(RecipientGameEventDocumentSchema).min(1).max(4),
  })
  .strict();

const AnsweredQuestionDocumentSchema = z
  .object({
    questionId: QuestionIdSchema,
    actorUserId: UserIdSchema,
  })
  .strict();

export const EngineStateCoreDocumentSchema = z
  .object({
    sessionId: SessionIdSchema,
    roomId: RoomIdSchema,
    caseId: CaseIdSchema,
    caseVersion: CaseVersionSchema,
    phase: GamePhaseSchema,
    version: VersionSchema,
    members: z.array(RoomMemberSchema).min(2).max(4),
    answeredQuestions: z.array(AnsweredQuestionDocumentSchema),
    revealedClues: z.array(StoredClueDocumentSchema),
    finalSubmission: FinalSubmissionSchema.nullable(),
    result: GameResultSchema.nullable(),
    startedAt: ServerIsoDateTimeSchema,
    finishedAt: ServerIsoDateTimeSchema.nullable(),
  })
  .strict();

export type EngineStateCoreDocument = z.infer<typeof EngineStateCoreDocumentSchema>;

export const ProviderAttemptDocumentSchema = z
  .object({
    attemptId: z.string().uuid(),
    executionId: z.string().uuid(),
    actorUserId: z.instanceof(ObjectId),
    operation: z.enum(['suspect:catalog', 'suspect:free_text']),
    aggregateId: SessionIdSchema,
    clientRequestId: ClientRequestIdSchema,
    mode: DialogueModeSchema,
    status: z.enum(['reserved', 'succeeded', 'failed']),
    reservedAt: z.date(),
    settledAt: z.date().nullable(),
  })
  .strict();
export type ProviderAttemptDocument = z.infer<typeof ProviderAttemptDocumentSchema>;

export const AiUsageDocumentSchema = z
  .object({
    providerAttemptsReserved: z.number().int().min(0).max(PROVIDER_ATTEMPT_LIMIT),
    attempts: z.array(ProviderAttemptDocumentSchema).max(PROVIDER_ATTEMPT_LIMIT),
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.providerAttemptsReserved !== usage.attempts.length) {
      context.addIssue({
        code: 'custom',
        path: ['providerAttemptsReserved'],
        message: 'The provider reservation counter must equal persisted attempt count',
      });
    }
    if (
      new Set(usage.attempts.map((attempt) => attempt.attemptId)).size !== usage.attempts.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['attempts'],
        message: 'Provider attempt IDs must be unique',
      });
    }
  });

export const RoomStartedIntentEventDocumentSchema = z
  .object({
    eventId: EventIdSchema,
    roomId: RoomIdSchema,
    version: VersionSchema,
    type: z.literal('room.started'),
    occurredAt: ServerIsoDateTimeSchema,
    payload: z.object({ sessionId: SessionIdSchema }).strict(),
  })
  .strict();

export const GameSessionDocumentSchema = z
  .object({
    _id: z.instanceof(ObjectId),
    schemaVersion: z.literal(GAME_SESSION_SCHEMA_VERSION),
    roomId: z.instanceof(ObjectId),
    startIntent: StartIntentDocumentSchema,
    roomStartedEvent: RoomStartedIntentEventDocumentSchema,
    caseId: CaseIdSchema,
    caseVersion: CaseVersionSchema,
    phase: GamePhaseSchema,
    version: VersionSchema,
    engineState: EngineStateCoreDocumentSchema,
    dialogues: z.array(StoredDialogueDocumentSchema),
    events: z.array(StoredGameEventDocumentSchema),
    actionReceipts: z.array(SessionActionReceiptDocumentSchema),
    aiUsage: AiUsageDocumentSchema,
    startedAt: z.date(),
    finishedAt: z.date().nullable(),
    updatedAt: z.date(),
    deleteAfter: z.date().nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    if (!session.startIntent.roomId.equals(session.roomId)) {
      context.addIssue({
        code: 'custom',
        path: ['startIntent', 'roomId'],
        message: 'The start intent must belong to the session room',
      });
    }
    if (
      session.engineState.sessionId !== session._id.toHexString() ||
      session.engineState.roomId !== session.roomId.toHexString() ||
      session.engineState.caseId !== session.caseId ||
      session.engineState.caseVersion !== session.caseVersion ||
      session.engineState.phase !== session.phase ||
      session.engineState.version !== session.version ||
      session.engineState.startedAt !== session.startedAt.toISOString() ||
      session.engineState.finishedAt !== (session.finishedAt?.toISOString() ?? null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['engineState'],
        message: 'Session and engine identity or lifecycle fields differ',
      });
    }
    const receiptKeys = new Set<string>();
    session.actionReceipts.forEach((receipt, index) => {
      const expectedAggregate =
        receipt.operation === 'room:start'
          ? session.roomId.toHexString()
          : session._id.toHexString();
      if (receiptKeys.has(receipt.lookupKey) || receipt.aggregateId !== expectedAggregate) {
        context.addIssue({
          code: 'custom',
          path: ['actionReceipts', index],
          message: 'Session receipts must be unique and use their authoritative aggregate scope',
        });
      }
      receiptKeys.add(receipt.lookupKey);
    });
    if (
      (session.phase === 'completed' && session.finishedAt === null) ||
      (session.phase === 'abandoned' && session.finishedAt === null) ||
      (session.phase === 'investigating' && session.finishedAt !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'Session lifecycle timestamps are inconsistent',
      });
    }
  });

export type GameSessionDocument = z.infer<typeof GameSessionDocumentSchema>;

export interface SessionStateMutation {
  engineState: EngineStateCoreDocument;
  dialogues: readonly StoredDialogue[];
  events: readonly StoredGameEvent[];
  actionReceipts: readonly SessionActionReceiptDocument[];
  phase: GameEngineState['phase'];
  version: number;
  startedAt: Date;
  finishedAt: Date | null;
  updatedAt: Date;
  deleteAfter: Date | null;
}

function isEngineReceipt(
  receipt: SessionActionReceiptDocument,
): receipt is SessionActionReceiptDocument & { operation: GameEngineOperation } {
  return receipt.operation === 'suspect:catalog' || receipt.operation === 'game:final';
}

export function engineStateFromDocument(document: GameSessionDocument): GameEngineState {
  return {
    ...document.engineState,
    dialogues: document.dialogues,
    receipts: document.actionReceipts.filter(isEngineReceipt).map((receipt) => ({
      actorUserId: receipt.actorUserId,
      operation: receipt.operation,
      aggregateId: receipt.aggregateId,
      clientRequestId: receipt.clientRequestId,
      payloadHash: receipt.payloadHash,
      eventId: receipt.eventId,
    })),
    events: document.events,
  };
}

export function mutationFromEngineState(
  previous: GameSessionDocument,
  state: GameEngineState,
  now: Date,
): SessionStateMutation {
  const previousReceipts = new Map(
    previous.actionReceipts.map((receipt) => [receipt.lookupKey, receipt]),
  );
  const actionReceipts = state.receipts.map((receipt) => {
    const lookupKey = receiptLookupKeyForState(receipt);
    const existing = previousReceipts.get(lookupKey);
    return (
      existing ?? {
        ...receipt,
        lookupKey,
        createdAt: now,
      }
    );
  });
  const finishedAt = state.finishedAt === null ? null : new Date(state.finishedAt);
  for (const existing of previous.actionReceipts) {
    if (existing.operation === 'suspect:free_text' || existing.operation === 'room:start') {
      actionReceipts.push(existing);
    }
  }

  return {
    engineState: {
      sessionId: state.sessionId,
      roomId: state.roomId,
      caseId: state.caseId,
      caseVersion: state.caseVersion,
      phase: state.phase,
      version: state.version,
      members: [...state.members],
      answeredQuestions: [...state.answeredQuestions],
      revealedClues: [...state.revealedClues],
      finalSubmission: state.finalSubmission,
      result: state.result,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
    },
    dialogues: state.dialogues,
    events: state.events,
    actionReceipts,
    phase: state.phase,
    version: state.version,
    startedAt: new Date(state.startedAt),
    finishedAt,
    updatedAt: now,
    deleteAfter: finishedAt === null ? null : new Date(finishedAt.getTime() + SESSION_RETENTION_MS),
  };
}

function receiptLookupKeyForState(receipt: ActionReceipt): string {
  return sha256ForReceipt(receipt);
}

function sha256ForReceipt(receipt: ActionReceipt): string {
  // This local helper is replaced by the application-level scope helper through identical canonical data.
  return digestHex(
    JSON.stringify({
      actorUserId: receipt.actorUserId,
      operation: receipt.operation,
      aggregateId: receipt.aggregateId,
      clientRequestId: receipt.clientRequestId,
    }),
  );
}

function digestHex(value: string): string {
  // Node's implementation is injected here without exposing hashes in any client projection.
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export type StoredGameEventDocument = StoredGameEvent;
export type StoredDialogueDocument = StoredDialogue;
export type StoredClueDocument = StoredClue;
export type ProjectedGameEvent = GameEvent;

export const CaseDefinitionDocumentSchema = z
  .object({
    _id: z.instanceof(ObjectId),
    schemaVersion: z.literal(1),
    id: CaseIdSchema,
    slug: CaseIdSchema,
    version: CaseVersionSchema,
    status: z.enum(['draft', 'published', 'retired']),
    summary: CaseSummarySchema,
    publicSuspects: z.tuple([PublicSuspectSchema, PublicSuspectSchema, PublicSuspectSchema]),
    suspectDefinitions: z
      .tuple([
        z
          .object({
            id: SuspectIdSchema,
            personality: z.string().min(1),
            knownFacts: z.array(z.string().min(1)),
            secret: z
              .object({
                concealedFact: z.string().min(1),
                tabooTopics: z.array(z.string().min(1)),
              })
              .strict(),
            allowedStatements: z.array(z.string().min(1)),
            speechStyle: z.string().min(1),
          })
          .strict(),
        z
          .object({
            id: SuspectIdSchema,
            personality: z.string().min(1),
            knownFacts: z.array(z.string().min(1)),
            secret: z
              .object({
                concealedFact: z.string().min(1),
                tabooTopics: z.array(z.string().min(1)),
              })
              .strict(),
            allowedStatements: z.array(z.string().min(1)),
            speechStyle: z.string().min(1),
          })
          .strict(),
        z
          .object({
            id: SuspectIdSchema,
            personality: z.string().min(1),
            knownFacts: z.array(z.string().min(1)),
            secret: z
              .object({
                concealedFact: z.string().min(1),
                tabooTopics: z.array(z.string().min(1)),
              })
              .strict(),
            allowedStatements: z.array(z.string().min(1)),
            speechStyle: z.string().min(1),
          })
          .strict(),
      ])
      .readonly(),
    questions: z.array(
      z
        .object({
          questionId: QuestionIdSchema,
          suspectId: SuspectIdSchema,
          text: z.string().min(1).max(500),
          referenceAnswer: z.string().min(1).max(4000),
          visibility: visibilitySchema,
          requiresQuestionIds: z.array(QuestionIdSchema),
          clueIds: z.array(ClueIdSchema),
        })
        .strict(),
    ),
    clues: z.array(
      z
        .object({
          id: ClueIdSchema,
          title: z.string().min(1).max(200),
          text: z.string().min(1).max(4000),
          visibility: visibilitySchema,
        })
        .strict(),
    ),
    truth: z
      .object({
        culpritId: SuspectIdSchema,
        resolution: CaseResolutionSchema,
        requiredEvidenceClueIds: z.array(ClueIdSchema),
        pointsPerEvidenceClue: z.number().int().min(0),
        correctVerdictBonus: z.number().int().min(0),
        maximumPoints: z.number().int().min(0),
      })
      .strict(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export type CaseDefinitionDocument = z.infer<typeof CaseDefinitionDocumentSchema>;

export function caseDefinitionFromDocument(document: CaseDefinitionDocument): CaseDefinition {
  return {
    schemaVersion: document.schemaVersion,
    id: document.id,
    version: document.version,
    status: 'published',
    summary: document.summary,
    publicSuspects: document.publicSuspects,
    suspectDefinitions: document.suspectDefinitions,
    questions: document.questions,
    clues: document.clues,
    truth: document.truth,
  };
}
