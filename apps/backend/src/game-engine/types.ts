import type {
  CaseId,
  CaseResolution,
  CaseSummary,
  CaseVersion,
  Clue,
  ClueId,
  ErrorCode,
  EventId,
  FinalSubmission,
  GameEvent,
  GamePhase,
  GameResult,
  QuestionId,
  PublicSuspect,
  RoomId,
  RoomMember,
  RoomStatus,
  ServerIsoDateTime,
  SessionId,
  StartGameRequest,
  SuspectDialogue,
  SuspectId,
  UserId,
} from '@casetogether/shared';

export type InformationVisibility = 'room' | 'actor';

export interface CaseQuestionDefinition {
  readonly questionId: QuestionId;
  readonly suspectId: SuspectId;
  readonly text: string;
  readonly referenceAnswer: string;
  readonly visibility: InformationVisibility;
  readonly requiresQuestionIds: readonly QuestionId[];
  readonly clueIds: readonly ClueId[];
}

export interface CaseClueDefinition {
  readonly id: ClueId;
  readonly title: string;
  readonly text: string;
  readonly visibility: InformationVisibility;
}

export interface SuspectSecret {
  readonly concealedFact: string;
  readonly tabooTopics: readonly string[];
}

export interface SuspectDefinition {
  readonly id: SuspectId;
  readonly personality: string;
  readonly knownFacts: readonly string[];
  readonly secret: SuspectSecret;
  readonly allowedStatements: readonly string[];
  readonly speechStyle: string;
}

/** Server-only. Never serialize this aggregate as a client DTO. */
export interface CaseTruth {
  readonly culpritId: SuspectId;
  readonly resolution: CaseResolution;
  readonly requiredEvidenceClueIds: readonly ClueId[];
  readonly pointsPerEvidenceClue: number;
  readonly correctVerdictBonus: number;
  readonly maximumPoints: number;
}

/** Server-only, immutable content pinned by caseId and caseVersion at start. */
export interface CaseDefinition {
  readonly schemaVersion: 1;
  readonly id: CaseId;
  readonly version: CaseVersion;
  readonly status: 'published';
  readonly summary: CaseSummary;
  readonly publicSuspects: readonly [PublicSuspect, PublicSuspect, PublicSuspect];
  readonly suspectDefinitions: readonly [SuspectDefinition, SuspectDefinition, SuspectDefinition];
  readonly questions: readonly CaseQuestionDefinition[];
  readonly clues: readonly CaseClueDefinition[];
  readonly truth: CaseTruth;
}

export interface AnsweredQuestion {
  readonly questionId: QuestionId;
  readonly actorUserId: UserId;
}

export interface StoredDialogue {
  readonly actorUserId: UserId;
  readonly visibility: InformationVisibility;
  readonly dialogue: SuspectDialogue;
}

export interface StoredClue {
  readonly actorUserId: UserId | null;
  readonly visibility: InformationVisibility;
  readonly clue: Clue;
}

export interface RecipientGameEvent {
  readonly recipientUserId: UserId;
  readonly event: GameEvent | null;
}

export interface StoredGameEvent {
  readonly eventId: EventId;
  readonly deliveries: readonly RecipientGameEvent[];
}

export type GameEngineOperation = 'suspect:catalog' | 'game:final';

export interface ActionReceipt {
  readonly actorUserId: UserId;
  readonly operation: GameEngineOperation;
  readonly aggregateId: SessionId;
  readonly clientRequestId: string;
  readonly payloadHash: string;
  readonly eventId: EventId;
}

/** Server-only aggregate. Public views are built exclusively by projection functions. */
export interface GameEngineState {
  readonly sessionId: SessionId;
  readonly roomId: RoomId;
  readonly caseId: CaseId;
  readonly caseVersion: CaseVersion;
  readonly phase: GamePhase;
  readonly version: number;
  readonly members: readonly RoomMember[];
  readonly answeredQuestions: readonly AnsweredQuestion[];
  readonly dialogues: readonly StoredDialogue[];
  readonly revealedClues: readonly StoredClue[];
  readonly finalSubmission: FinalSubmission | null;
  readonly result: GameResult | null;
  readonly startedAt: ServerIsoDateTime;
  readonly finishedAt: ServerIsoDateTime | null;
  readonly receipts: readonly ActionReceipt[];
  readonly events: readonly StoredGameEvent[];
}

export type EngineErrorCode = Extract<
  ErrorCode,
  | 'VALIDATION_ERROR'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'QUESTION_NOT_AVAILABLE'
  | 'INVALID_STATE_TRANSITION'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
>;

export interface EngineError {
  readonly code: EngineErrorCode;
  readonly message: string;
  readonly details?: { readonly currentVersion: number };
}

export type EngineResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: EngineError };

export interface GameStartContext {
  readonly roomId: RoomId;
  readonly sessionId: SessionId;
  readonly roomStatus: RoomStatus;
  readonly roomVersion: number;
  readonly members: readonly RoomMember[];
  readonly actorUserId: UserId;
  readonly request: StartGameRequest;
  readonly occurredAt: string;
}

export interface GameStartSuccess {
  readonly state: GameEngineState;
  readonly eventId: EventId;
  readonly recipientEvents: readonly RecipientGameEvent[];
}

export interface GameCommandSuccess {
  readonly state: GameEngineState;
  readonly eventId: EventId;
  readonly recipientEvents: readonly RecipientGameEvent[];
  readonly replayed: boolean;
}

export interface AbandonGameCommand {
  readonly reason: 'expired' | 'server_timeout';
  readonly expectedVersion: number;
  readonly occurredAt: string;
}
