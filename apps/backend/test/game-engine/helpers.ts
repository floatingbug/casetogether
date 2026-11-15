import {
  ClientRequestIdSchema,
  PublicUserSchema,
  RoomIdSchema,
  RoomMemberSchema,
  SessionIdSchema,
  UserIdSchema,
  type CatalogQuestionRequest,
  type FinalSubmissionRequest,
  type GameEvent,
  type GameSnapshot,
  type QuestionId,
  type SuspectId,
  type UserId,
} from '@casetogether/shared';
import {
  STILLER_GLOCKENSCHLAG_CASE,
  abandonGame,
  askCatalogQuestion,
  getGameSnapshot,
  glockenschlagIds,
  startGame,
  submitFinalSolution,
  type AbandonGameCommand,
  type EngineError,
  type EngineResult,
  type GameCommandSuccess,
  type GameEngineState,
  type GameStartContext,
  type GameStartSuccess,
} from '../../src/game-engine/index.js';

export const testUsers = {
  host: PublicUserSchema.parse({ id: 'user-host', displayName: 'Host' }),
  guest: PublicUserSchema.parse({ id: 'user-guest', displayName: 'Gast' }),
  third: PublicUserSchema.parse({ id: 'user-third', displayName: 'Dritte Person' }),
  fourth: PublicUserSchema.parse({ id: 'user-fourth', displayName: 'Vierte Person' }),
  outsider: PublicUserSchema.parse({ id: 'user-outsider', displayName: 'Außenstehende Person' }),
  fifth: PublicUserSchema.parse({ id: 'user-fifth', displayName: 'Fünfte Person' }),
} as const;

export const OUTSIDER_ID = UserIdSchema.parse(testUsers.outsider.id);

export function requestId(sequence: number): string {
  return ClientRequestIdSchema.parse(
    `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  );
}

export function time(sequence: number): string {
  return new Date(Date.UTC(2026, 10, 15, 20, 0, 0) + sequence * 1_000).toISOString();
}

export function makeMembers(count: number) {
  const roster = [
    testUsers.host,
    testUsers.guest,
    testUsers.third,
    testUsers.fourth,
    testUsers.fifth,
  ];
  return roster.slice(0, count).map((user, index) =>
    RoomMemberSchema.parse({
      user,
      role: index === 0 ? 'host' : 'member',
      joinedAt: time(index),
    }),
  );
}

export function makeStartContext(memberCount = 2, suffix = 'default'): GameStartContext {
  const members = makeMembers(memberCount);
  return {
    roomId: RoomIdSchema.parse(`room-${memberCount}-${suffix}`),
    sessionId: SessionIdSchema.parse(`session-${memberCount}-${suffix}`),
    roomStatus: 'ready',
    roomVersion: 7,
    members,
    actorUserId: testUsers.host.id,
    request: {
      clientRequestId: requestId(1),
      caseId: glockenschlagIds.caseId,
      expectedVersion: 7,
    },
    occurredAt: time(1),
  };
}

export function must<Value>(result: EngineResult<Value>): Value {
  if (!result.ok) {
    throw new Error(`Expected successful engine result, got ${result.error.code}`);
  }
  return result.value;
}

export function mustFailure<Value>(result: EngineResult<Value>): EngineError {
  if (result.ok) {
    throw new Error('Expected failed engine result');
  }
  return result.error;
}

export function start(memberCount = 2, suffix = 'default'): GameStartSuccess {
  return must(startGame(STILLER_GLOCKENSCHLAG_CASE, makeStartContext(memberCount, suffix)));
}

export function startState(memberCount = 2, suffix = 'default'): GameEngineState {
  return start(memberCount, suffix).state;
}

export function catalogRequest(
  state: GameEngineState,
  questionId: QuestionId,
  sequence: number,
  overrides: Partial<CatalogQuestionRequest> = {},
): CatalogQuestionRequest {
  const question = STILLER_GLOCKENSCHLAG_CASE.questions.find(
    (candidate) => candidate.questionId === questionId,
  );
  if (question === undefined) {
    throw new Error('Unknown test question');
  }
  return {
    sessionId: state.sessionId,
    clientRequestId: requestId(sequence),
    expectedVersion: state.version,
    suspectId: question.suspectId,
    mode: 'catalog',
    questionId,
    ...overrides,
  };
}

export function answer(
  state: GameEngineState,
  actorUserId: GameEngineState['members'][number]['user']['id'],
  questionId: QuestionId,
  sequence: number,
): GameCommandSuccess {
  return must(
    askCatalogQuestion(
      STILLER_GLOCKENSCHLAG_CASE,
      state,
      actorUserId,
      catalogRequest(state, questionId, sequence),
      time(sequence),
    ),
  );
}

export function finalRequest(
  state: GameEngineState,
  suspectId: SuspectId,
  sequence: number,
  overrides: Partial<FinalSubmissionRequest> = {},
): FinalSubmissionRequest {
  return {
    clientRequestId: requestId(sequence),
    expectedVersion: state.version,
    suspectId,
    ...overrides,
  };
}

export function finish(
  state: GameEngineState,
  actorUserId: GameEngineState['members'][number]['user']['id'],
  suspectId: SuspectId,
  sequence: number,
): GameCommandSuccess {
  return must(
    submitFinalSolution(
      STILLER_GLOCKENSCHLAG_CASE,
      state,
      actorUserId,
      finalRequest(state, suspectId, sequence),
      time(sequence),
    ),
  );
}

export function abandon(
  state: GameEngineState,
  sequence: number,
  overrides: Partial<Omit<AbandonGameCommand, 'occurredAt'>> = {},
): GameCommandSuccess {
  return must(
    abandonGame(STILLER_GLOCKENSCHLAG_CASE, state, {
      reason: 'expired',
      expectedVersion: state.version,
      occurredAt: time(sequence),
      ...overrides,
    }),
  );
}

export function snapshot(state: GameEngineState, actorUserId = testUsers.host.id): GameSnapshot {
  return must(getGameSnapshot(STILLER_GLOCKENSCHLAG_CASE, state, actorUserId));
}

export function eventFor(success: GameStartSuccess | GameCommandSuccess, actorUserId: string) {
  const delivery = success.recipientEvents.find(
    (recipient) => recipient.recipientUserId === actorUserId,
  );
  if (delivery === undefined) {
    throw new Error('Missing recipient event');
  }
  return delivery.event;
}

export function nonNullEvent(
  success: GameStartSuccess | GameCommandSuccess,
  actorUserId: string,
): GameEvent {
  const event = eventFor(success, actorUserId);
  if (event === null) {
    throw new Error('Expected visible event');
  }
  return event;
}

export interface EvidenceStep {
  readonly actorUserId: UserId;
  readonly questionId: QuestionId;
}

export const SUCCESS_QUESTION_SEQUENCE: readonly EvidenceStep[] = [
  {
    actorUserId: testUsers.host.id,
    questionId: glockenschlagIds.questions.jonasTeacup,
  },
  {
    actorUserId: testUsers.host.id,
    questionId: glockenschlagIds.questions.jonasRound,
  },
  {
    actorUserId: testUsers.host.id,
    questionId: glockenschlagIds.questions.jonasInventory,
  },
  {
    actorUserId: testUsers.guest.id,
    questionId: glockenschlagIds.questions.selinProgram,
  },
  {
    actorUserId: testUsers.host.id,
    questionId: glockenschlagIds.questions.miriamTea,
  },
  {
    actorUserId: testUsers.host.id,
    questionId: glockenschlagIds.questions.miriamConcentrate,
  },
  {
    actorUserId: testUsers.host.id,
    questionId: glockenschlagIds.questions.selinTray,
  },
  {
    actorUserId: testUsers.host.id,
    questionId: glockenschlagIds.questions.jonasControl,
  },
  {
    actorUserId: testUsers.host.id,
    questionId: glockenschlagIds.questions.selinSpeech,
  },
];

export interface EvidencePath {
  readonly initialState: GameEngineState;
  readonly state: GameEngineState;
  readonly commands: readonly GameCommandSuccess[];
}

export function runEvidencePath(
  initialState = startState(),
  sequencePlan = SUCCESS_QUESTION_SEQUENCE,
): EvidencePath {
  let state = initialState;
  const commands: GameCommandSuccess[] = [];
  sequencePlan.forEach((step, index) => {
    const sequence = index + 10;
    const command = answer(state, step.actorUserId, step.questionId, sequence);
    commands.push(command);
    state = command.state;
  });
  return { initialState, state, commands };
}

export function runCompleteGame(suffix = 'complete') {
  const path = runEvidencePath(startState(2, suffix));
  const final = finish(path.state, testUsers.guest.id, glockenschlagIds.suspects.miriam, 90);
  return { path, final, state: final.state };
}
