import {
  CatalogQuestionRequestSchema,
  DialogueIdSchema,
  EventIdSchema,
  FinalSubmissionRequestSchema,
  GameResultSchema,
  ServerIsoDateTimeSchema,
  StartGameRequestSchema,
  SuspectDialogueSchema,
  VersionSchema,
  type CatalogQuestionRequest,
  type ClueId,
  type FinalSubmissionRequest,
  type GameResult,
  type ServerIsoDateTime,
  type StartGameRequest,
  type SuspectId,
  type UserId,
} from '@casetogether/shared';
import {
  deterministicId,
  hashCatalogQuestionPayload,
  hashFinalSubmissionPayload,
} from './deterministic.js';
import {
  failure,
  invalidState,
  notMember,
  questionUnavailable,
  versionConflict,
} from './errors.js';
import { isQuestionAvailable, projectQuestionEvent, projectSnapshotEvent } from './projection.js';
import type {
  AbandonGameCommand,
  ActionReceipt,
  CaseClueDefinition,
  CaseDefinition,
  EngineResult,
  GameCommandSuccess,
  GameEngineOperation,
  GameEngineState,
  GameStartContext,
  GameStartSuccess,
  StoredClue,
} from './types.js';

function samePinnedCase(caseDefinition: CaseDefinition, state: GameEngineState): boolean {
  return caseDefinition.id === state.caseId && caseDefinition.version === state.caseVersion;
}

function isMember(
  state: { readonly members: GameEngineState['members'] },
  actorUserId: UserId,
): boolean {
  return state.members.some((member) => member.user.id === actorUserId);
}

function parseTime(occurredAt: string): ServerIsoDateTime | null {
  const parsed = ServerIsoDateTimeSchema.safeParse(occurredAt);
  return parsed.success ? parsed.data : null;
}

function invalidCommand<Value>(message: string): EngineResult<Value> {
  return failure<Value>('VALIDATION_ERROR', message);
}

function validateCase(caseDefinition: CaseDefinition): boolean {
  const truth = caseDefinition.truth;
  const suspectIds = new Set(caseDefinition.publicSuspects.map((suspect) => suspect.id));
  const questionIds = new Set(caseDefinition.questions.map((question) => question.questionId));
  const clueIds = new Set(caseDefinition.clues.map((clue) => clue.id));
  return (
    caseDefinition.summary.id === caseDefinition.id &&
    caseDefinition.publicSuspects.length === 3 &&
    suspectIds.size === caseDefinition.publicSuspects.length &&
    suspectIds.has(truth.culpritId) &&
    questionIds.size === caseDefinition.questions.length &&
    clueIds.size === caseDefinition.clues.length &&
    caseDefinition.questions.every(
      (question) =>
        suspectIds.has(question.suspectId) &&
        question.referenceAnswer.trim().length > 0 &&
        question.requiresQuestionIds.every((requiredId) => questionIds.has(requiredId)) &&
        question.clueIds.every((clueId) => clueIds.has(clueId)),
    ) &&
    truth.requiredEvidenceClueIds.every((clueId) => clueIds.has(clueId)) &&
    new Set(truth.requiredEvidenceClueIds).size === truth.requiredEvidenceClueIds.length &&
    truth.pointsPerEvidenceClue * truth.requiredEvidenceClueIds.length +
      truth.correctVerdictBonus ===
      truth.maximumPoints
  );
}

function findReceipt(
  state: GameEngineState,
  actorUserId: UserId,
  operation: GameEngineOperation,
  clientRequestId: string,
): ActionReceipt | undefined {
  return state.receipts.find(
    (receipt) =>
      receipt.actorUserId === actorUserId &&
      receipt.operation === operation &&
      receipt.aggregateId === state.sessionId &&
      receipt.clientRequestId === clientRequestId,
  );
}

function replayCommand(
  state: GameEngineState,
  actorUserId: UserId,
  operation: GameEngineOperation,
  clientRequestId: string,
  payloadHash: string,
): EngineResult<GameCommandSuccess> | null {
  const receipt = findReceipt(state, actorUserId, operation, clientRequestId);
  if (receipt === undefined) {
    return null;
  }
  if (receipt.payloadHash !== payloadHash) {
    return failure<GameCommandSuccess>(
      'IDEMPOTENCY_KEY_REUSED',
      'Diese Anfrage-ID wurde bereits mit einem anderen Inhalt verwendet.',
    );
  }
  const storedEvent = state.events.find((event) => event.eventId === receipt.eventId);
  if (storedEvent === undefined) {
    return invalidCommand<GameCommandSuccess>('Der Sessionstatus ist nicht konsistent.');
  }
  return {
    ok: true,
    value: {
      state,
      eventId: receipt.eventId,
      recipientEvents: storedEvent.deliveries,
      replayed: true,
    },
  };
}

function makeEventId(parts: readonly string[]) {
  return EventIdSchema.parse(deterministicId('event', parts));
}

function revealNewClues(
  caseDefinition: CaseDefinition,
  state: GameEngineState,
  clueIds: readonly ClueId[],
  actorUserId: UserId,
  occurredAt: ServerIsoDateTime,
): StoredClue[] {
  const newClues: StoredClue[] = [];
  for (const clueId of clueIds) {
    const definition: CaseClueDefinition | undefined = caseDefinition.clues.find(
      (clue) => clue.id === clueId,
    );
    if (definition === undefined) {
      continue;
    }
    const alreadyRevealed = state.revealedClues.some(
      (stored) =>
        stored.clue.id === clueId &&
        stored.visibility === definition.visibility &&
        (definition.visibility === 'room' || stored.actorUserId === actorUserId),
    );
    if (!alreadyRevealed) {
      newClues.push({
        actorUserId: definition.visibility === 'actor' ? actorUserId : null,
        visibility: definition.visibility,
        clue: {
          id: definition.id,
          title: definition.title,
          text: definition.text,
          discoveredAt: occurredAt,
        },
      });
    }
  }
  return newClues;
}

export function startGame(
  caseDefinition: CaseDefinition,
  context: GameStartContext,
): EngineResult<GameStartSuccess> {
  const parsedRequest = StartGameRequestSchema.safeParse(context.request);
  const occurredAt = parseTime(context.occurredAt);
  if (!parsedRequest.success || occurredAt === null) {
    return invalidCommand<GameStartSuccess>('Startdaten oder Zeitstempel sind ungültig.');
  }
  if (!validateCase(caseDefinition)) {
    return invalidCommand<GameStartSuccess>('Die Falldefinition ist nicht konsistent.');
  }
  if (context.members.length < 2 || context.members.length > 4) {
    return invalidState<GameStartSuccess>('Ein Spiel benötigt zwei bis vier Mitglieder.');
  }
  if (!isMember(context, context.actorUserId)) {
    return notMember<GameStartSuccess>();
  }
  if (context.roomStatus !== 'ready') {
    return invalidState<GameStartSuccess>(
      'Ein Spiel kann nur aus einem startbereiten Raum starten.',
    );
  }
  const hosts = context.members.filter((member) => member.role === 'host');
  const uniqueMemberIds = new Set(context.members.map((member) => member.user.id));
  if (hosts.length !== 1 || uniqueMemberIds.size !== context.members.length) {
    return invalidCommand<GameStartSuccess>('Die Raum-Mitgliedschaft ist nicht eindeutig.');
  }
  const actor = context.members.find((member) => member.user.id === context.actorUserId);
  if (actor?.role !== 'host') {
    return failure<GameStartSuccess>('FORBIDDEN', 'Nur der Host darf den Fall starten.');
  }
  if (parsedRequest.data.expectedVersion !== context.roomVersion) {
    return versionConflict<GameStartSuccess>(context.roomVersion);
  }
  if (parsedRequest.data.caseId !== caseDefinition.id) {
    return notMember<GameStartSuccess>();
  }

  const request: StartGameRequest = parsedRequest.data;
  const initialState: GameEngineState = {
    sessionId: context.sessionId,
    roomId: context.roomId,
    caseId: caseDefinition.id,
    caseVersion: caseDefinition.version,
    phase: 'investigating',
    version: 1,
    members: context.members,
    answeredQuestions: [],
    dialogues: [],
    revealedClues: [],
    finalSubmission: null,
    result: null,
    startedAt: occurredAt,
    finishedAt: null,
    receipts: [],
    events: [],
  };
  const eventId = makeEventId([context.sessionId, 'game.started', request.clientRequestId, '1']);
  const recipientEvents = projectSnapshotEvent(
    caseDefinition,
    initialState,
    eventId,
    'game.started',
    occurredAt,
  );
  const state: GameEngineState = {
    ...initialState,
    events: [{ eventId, deliveries: recipientEvents }],
  };
  return { ok: true, value: { state, eventId, recipientEvents } };
}

export function askCatalogQuestion(
  caseDefinition: CaseDefinition,
  state: GameEngineState,
  actorUserId: UserId,
  requestInput: CatalogQuestionRequest,
  occurredAtInput: string,
): EngineResult<GameCommandSuccess> {
  const parsedRequest = CatalogQuestionRequestSchema.safeParse(requestInput);
  const occurredAt = parseTime(occurredAtInput);
  if (!parsedRequest.success || occurredAt === null) {
    return invalidCommand<GameCommandSuccess>('Katalogdaten oder Zeitstempel sind ungültig.');
  }
  const request = parsedRequest.data;
  if (request.sessionId !== state.sessionId || !samePinnedCase(caseDefinition, state)) {
    return notMember<GameCommandSuccess>();
  }
  if (!isMember(state, actorUserId)) {
    return notMember<GameCommandSuccess>();
  }
  const payloadHash = hashCatalogQuestionPayload(state.sessionId, request);
  const replay = replayCommand(
    state,
    actorUserId,
    'suspect:catalog',
    request.clientRequestId,
    payloadHash,
  );
  if (replay !== null) {
    return replay;
  }
  if (request.expectedVersion !== state.version) {
    return versionConflict<GameCommandSuccess>(state.version);
  }
  if (state.phase !== 'investigating') {
    return invalidState<GameCommandSuccess>(
      'In einer beendeten Session kann nicht befragt werden.',
    );
  }
  const question = caseDefinition.questions.find(
    (candidate) => candidate.questionId === request.questionId,
  );
  if (
    question === undefined ||
    question.suspectId !== request.suspectId ||
    !caseDefinition.publicSuspects.some((suspect) => suspect.id === request.suspectId) ||
    !isQuestionAvailable(caseDefinition, state, actorUserId, question)
  ) {
    return questionUnavailable<GameCommandSuccess>();
  }

  const version = VersionSchema.parse(state.version + 1);
  const actor = state.members.find((member) => member.user.id === actorUserId);
  if (actor === undefined) {
    return notMember<GameCommandSuccess>();
  }
  const dialogueId = DialogueIdSchema.parse(
    deterministicId('dialogue', [
      state.sessionId,
      'suspect:catalog',
      actorUserId,
      request.clientRequestId,
      request.questionId,
    ]),
  );
  const dialogue = SuspectDialogueSchema.parse({
    id: dialogueId,
    suspectId: question.suspectId,
    mode: 'catalog',
    questionId: question.questionId,
    questionText: question.text,
    answerText: question.referenceAnswer,
    answerSource: 'reference',
    askedBy: actor.user,
    createdAt: occurredAt,
  });
  const eventId = makeEventId([
    state.sessionId,
    'suspect.answered',
    actorUserId,
    request.clientRequestId,
    String(version),
  ]);
  const newClues = revealNewClues(caseDefinition, state, question.clueIds, actorUserId, occurredAt);
  const nextState: GameEngineState = {
    ...state,
    version,
    answeredQuestions: [
      ...state.answeredQuestions,
      { questionId: question.questionId, actorUserId },
    ],
    dialogues: [...state.dialogues, { actorUserId, visibility: question.visibility, dialogue }],
    revealedClues: [...state.revealedClues, ...newClues],
  };
  const recipientEvents = projectQuestionEvent({
    caseDefinition,
    previousState: state,
    state: nextState,
    eventId,
    occurredAt,
    question,
    actorUserId,
    dialogue,
    newPublicClues: newClues.filter((clue) => clue.visibility === 'room').map((clue) => clue.clue),
    newPrivateClues: newClues
      .filter((clue) => clue.visibility === 'actor')
      .map((clue) => clue.clue),
  });
  const receipt: ActionReceipt = {
    actorUserId,
    operation: 'suspect:catalog',
    aggregateId: state.sessionId,
    clientRequestId: request.clientRequestId,
    payloadHash,
    eventId,
  };
  const mutatedState: GameEngineState = {
    ...nextState,
    receipts: [...state.receipts, receipt],
    events: [...state.events, { eventId, deliveries: recipientEvents }],
  };
  return {
    ok: true,
    value: { state: mutatedState, eventId, recipientEvents, replayed: false },
  };
}

function discoveredEvidenceCount(caseDefinition: CaseDefinition, state: GameEngineState): number {
  const required = new Set(caseDefinition.truth.requiredEvidenceClueIds);
  const discovered = new Set(
    state.revealedClues
      .filter((stored) => required.has(stored.clue.id))
      .map((stored) => stored.clue.id),
  );
  return discovered.size;
}

function makeGameResult(
  caseDefinition: CaseDefinition,
  state: GameEngineState,
  submittedSuspectId: SuspectId,
): GameResult {
  const truth = caseDefinition.truth;
  const correct = submittedSuspectId === truth.culpritId;
  const discoveredEvidence = discoveredEvidenceCount(caseDefinition, state);
  const totalEvidence = truth.requiredEvidenceClueIds.length;
  const awardedPoints =
    discoveredEvidence * truth.pointsPerEvidenceClue + (correct ? truth.correctVerdictBonus : 0);
  const feedback = correct
    ? `Die Täterwahl ist richtig. Ihr habt ${discoveredEvidence} von ${totalEvidence} entscheidenden Beweisen aufgedeckt und ${awardedPoints} von ${truth.maximumPoints} Punkten erreicht.`
    : `Die Verurteilung ist falsch. Ihr habt ${discoveredEvidence} von ${totalEvidence} entscheidenden Beweisen aufgedeckt und erhaltet ${awardedPoints} von ${truth.maximumPoints} Punkten. Die vollständige Auflösung zeigt die kanonische Beweisführung.`;
  return GameResultSchema.parse({
    verdict: correct ? 'correct' : 'incorrect',
    awardedPoints,
    maximumPoints: truth.maximumPoints,
    feedback,
    resolution: truth.resolution,
  });
}

export function submitFinalSolution(
  caseDefinition: CaseDefinition,
  state: GameEngineState,
  actorUserId: UserId,
  requestInput: FinalSubmissionRequest,
  occurredAtInput: string,
): EngineResult<GameCommandSuccess> {
  const parsedRequest = FinalSubmissionRequestSchema.safeParse(requestInput);
  const occurredAt = parseTime(occurredAtInput);
  if (!parsedRequest.success || occurredAt === null) {
    return invalidCommand<GameCommandSuccess>('Finalabgabe oder Zeitstempel ist ungültig.');
  }
  const request = parsedRequest.data;
  if (!samePinnedCase(caseDefinition, state)) {
    return notMember<GameCommandSuccess>();
  }
  if (!isMember(state, actorUserId)) {
    return notMember<GameCommandSuccess>();
  }
  const payloadHash = hashFinalSubmissionPayload(state.sessionId, request);
  const replay = replayCommand(
    state,
    actorUserId,
    'game:final',
    request.clientRequestId,
    payloadHash,
  );
  if (replay !== null) {
    return replay;
  }
  if (request.expectedVersion !== state.version) {
    return versionConflict<GameCommandSuccess>(state.version);
  }
  if (state.phase !== 'investigating') {
    return invalidState<GameCommandSuccess>('Die Session ist bereits beendet.');
  }
  if (!caseDefinition.publicSuspects.some((suspect) => suspect.id === request.suspectId)) {
    return invalidCommand<GameCommandSuccess>('Die finale Abgabe nennt keinen Fallverdächtigen.');
  }

  const actor = state.members.find((member) => member.user.id === actorUserId);
  if (actor === undefined) {
    return notMember<GameCommandSuccess>();
  }
  const version = VersionSchema.parse(state.version + 1);
  const result = makeGameResult(caseDefinition, state, request.suspectId);
  const terminalWithoutHistory: GameEngineState = {
    ...state,
    phase: 'completed',
    version,
    finalSubmission: {
      suspectId: request.suspectId,
      submittedBy: actor.user,
      submittedAt: occurredAt,
    },
    result,
    finishedAt: occurredAt,
  };
  const eventId = makeEventId([
    state.sessionId,
    'game.completed',
    actorUserId,
    request.clientRequestId,
    String(version),
  ]);
  const recipientEvents = projectSnapshotEvent(
    caseDefinition,
    terminalWithoutHistory,
    eventId,
    'game.completed',
    occurredAt,
  );
  const receipt: ActionReceipt = {
    actorUserId,
    operation: 'game:final',
    aggregateId: state.sessionId,
    clientRequestId: request.clientRequestId,
    payloadHash,
    eventId,
  };
  const mutatedState: GameEngineState = {
    ...terminalWithoutHistory,
    receipts: [...state.receipts, receipt],
    events: [...state.events, { eventId, deliveries: recipientEvents }],
  };
  return {
    ok: true,
    value: { state: mutatedState, eventId, recipientEvents, replayed: false },
  };
}

export function abandonGame(
  caseDefinition: CaseDefinition,
  state: GameEngineState,
  command: AbandonGameCommand,
): EngineResult<GameCommandSuccess> {
  const occurredAt = parseTime(command.occurredAt);
  const parsedVersion = VersionSchema.safeParse(command.expectedVersion);
  const validReason = command.reason === 'expired' || command.reason === 'server_timeout';
  if (occurredAt === null || !parsedVersion.success || !validReason) {
    return invalidCommand<GameCommandSuccess>('Abbruchdaten oder Zeitstempel sind ungültig.');
  }
  if (!samePinnedCase(caseDefinition, state)) {
    return notMember<GameCommandSuccess>();
  }
  if (command.expectedVersion !== state.version) {
    return versionConflict<GameCommandSuccess>(state.version);
  }
  if (state.phase !== 'investigating') {
    return invalidState<GameCommandSuccess>('Nur eine laufende Session kann abgebrochen werden.');
  }
  const version = VersionSchema.parse(state.version + 1);
  const terminalWithoutHistory: GameEngineState = {
    ...state,
    phase: 'abandoned',
    version,
    finalSubmission: null,
    result: null,
    finishedAt: occurredAt,
  };
  const eventId = makeEventId([state.sessionId, 'game.abandoned', command.reason, String(version)]);
  const recipientEvents = projectSnapshotEvent(
    caseDefinition,
    terminalWithoutHistory,
    eventId,
    'game.abandoned',
    occurredAt,
  );
  const mutatedState: GameEngineState = {
    ...terminalWithoutHistory,
    events: [...state.events, { eventId, deliveries: recipientEvents }],
  };
  return {
    ok: true,
    value: { state: mutatedState, eventId, recipientEvents, replayed: false },
  };
}
