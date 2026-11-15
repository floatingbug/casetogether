import {
  GameEventSchema,
  GameSnapshotSchema,
  type CatalogQuestion,
  type Clue,
  type EventId,
  type GameEvent,
  type GameSnapshot,
  type QuestionId,
  type SuspectDialogue,
  type UserId,
} from '@casetogether/shared';
import { notMember } from './errors.js';
import type {
  CaseDefinition,
  CaseQuestionDefinition,
  EngineResult,
  GameEngineState,
  InformationVisibility,
  RecipientGameEvent,
} from './types.js';

function compareChronologically(
  left: { readonly discoveredAt: string; readonly id: string },
  right: { readonly discoveredAt: string; readonly id: string },
): number {
  const byDate = left.discoveredAt.localeCompare(right.discoveredAt);
  return byDate === 0 ? left.id.localeCompare(right.id) : byDate;
}

function compareDialogues(left: SuspectDialogue, right: SuspectDialogue): number {
  const byDate = left.createdAt.localeCompare(right.createdAt);
  return byDate === 0 ? left.id.localeCompare(right.id) : byDate;
}

function isMember(state: GameEngineState, actorUserId: UserId): boolean {
  return state.members.some((member) => member.user.id === actorUserId);
}

export function findQuestion(
  caseDefinition: CaseDefinition,
  questionId: QuestionId,
): CaseQuestionDefinition | undefined {
  return caseDefinition.questions.find((question) => question.questionId === questionId);
}

function isAnsweredForActor(
  state: GameEngineState,
  actorUserId: UserId,
  target: CaseQuestionDefinition,
  prerequisite: CaseQuestionDefinition,
): boolean {
  return state.answeredQuestions.some(
    (answer) =>
      answer.questionId === prerequisite.questionId &&
      (target.visibility === 'actor'
        ? answer.actorUserId === actorUserId
        : prerequisite.visibility === 'room' || answer.actorUserId === actorUserId),
  );
}

export function isQuestionAvailable(
  caseDefinition: CaseDefinition,
  state: GameEngineState,
  actorUserId: UserId,
  question: CaseQuestionDefinition,
): boolean {
  if (state.phase !== 'investigating' || !isMember(state, actorUserId)) {
    return false;
  }
  return question.requiresQuestionIds.every((requiredId) => {
    const prerequisite = findQuestion(caseDefinition, requiredId);
    return (
      prerequisite !== undefined && isAnsweredForActor(state, actorUserId, question, prerequisite)
    );
  });
}

function availableQuestionDefinitions(
  caseDefinition: CaseDefinition,
  state: GameEngineState,
  actorUserId: UserId,
): readonly CaseQuestionDefinition[] {
  return caseDefinition.questions.filter((question) =>
    isQuestionAvailable(caseDefinition, state, actorUserId, question),
  );
}

function publicCatalogQuestion(question: CaseQuestionDefinition): CatalogQuestion {
  return {
    questionId: question.questionId,
    suspectId: question.suspectId,
    text: question.text,
  };
}

function availableQuestions(
  caseDefinition: CaseDefinition,
  state: GameEngineState,
  actorUserId: UserId,
): CatalogQuestion[] {
  return availableQuestionDefinitions(caseDefinition, state, actorUserId).map(
    publicCatalogQuestion,
  );
}

function sortedVisibleClues(
  state: GameEngineState,
  actorUserId: UserId,
  visibility: InformationVisibility,
): Clue[] {
  return state.revealedClues
    .filter(
      (stored) =>
        stored.visibility === visibility &&
        (visibility === 'room' || stored.actorUserId === actorUserId),
    )
    .map((stored) => stored.clue)
    .sort(compareChronologically);
}

function snapshotForMember(
  caseDefinition: CaseDefinition,
  state: GameEngineState,
  actorUserId: UserId,
): GameSnapshot {
  return GameSnapshotSchema.parse({
    sessionId: state.sessionId,
    roomId: state.roomId,
    caseId: state.caseId,
    caseVersion: state.caseVersion,
    phase: state.phase,
    version: state.version,
    members: state.members,
    suspects: caseDefinition.publicSuspects,
    availableQuestions: availableQuestions(caseDefinition, state, actorUserId),
    publicClues: sortedVisibleClues(state, actorUserId, 'room'),
    privateClues: sortedVisibleClues(state, actorUserId, 'actor'),
    dialogues: state.dialogues
      .filter((stored) => stored.visibility === 'room' || stored.actorUserId === actorUserId)
      .map((stored) => stored.dialogue)
      .sort(compareDialogues),
    finalSubmission: state.finalSubmission,
    result: state.phase === 'completed' ? state.result : null,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  });
}

export function getGameSnapshot(
  caseDefinition: CaseDefinition,
  state: GameEngineState,
  actorUserId: UserId,
): EngineResult<GameSnapshot> {
  if (!isMember(state, actorUserId)) {
    return notMember<GameSnapshot>();
  }
  return { ok: true, value: snapshotForMember(caseDefinition, state, actorUserId) };
}

function sameQuestionIds(left: readonly QuestionId[], right: readonly QuestionId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function projectSnapshotEvent(
  caseDefinition: CaseDefinition,
  state: GameEngineState,
  eventId: EventId,
  type: 'game.started' | 'game.completed' | 'game.abandoned',
  occurredAt: string,
): RecipientGameEvent[] {
  return state.members.map((member) => ({
    recipientUserId: member.user.id,
    event: GameEventSchema.parse({
      eventId,
      sessionId: state.sessionId,
      version: state.version,
      type,
      occurredAt,
      payload: {
        snapshot: snapshotForMember(caseDefinition, state, member.user.id),
      },
    }),
  }));
}

export interface QuestionEventProjectionInput {
  readonly caseDefinition: CaseDefinition;
  readonly previousState: GameEngineState;
  readonly state: GameEngineState;
  readonly eventId: EventId;
  readonly occurredAt: string;
  readonly question: CaseQuestionDefinition;
  readonly actorUserId: UserId;
  readonly dialogue: SuspectDialogue;
  readonly newPublicClues: readonly Clue[];
  readonly newPrivateClues: readonly Clue[];
}

export function projectQuestionEvent(input: QuestionEventProjectionInput): RecipientGameEvent[] {
  const {
    caseDefinition,
    previousState,
    state,
    eventId,
    occurredAt,
    question,
    actorUserId,
    dialogue,
    newPublicClues,
    newPrivateClues,
  } = input;

  return state.members.map((member) => {
    const recipientUserId = member.user.id;
    const recipientQuestionsBefore = availableQuestionDefinitions(
      caseDefinition,
      previousState,
      recipientUserId,
    ).map((available) => available.questionId);
    const recipientQuestions = availableQuestions(caseDefinition, state, recipientUserId);
    const recipientQuestionIds = recipientQuestions.map((available) => available.questionId);
    const visibleDialogue =
      question.visibility === 'room' || recipientUserId === actorUserId ? dialogue : null;
    const privateClues = recipientUserId === actorUserId ? [...newPrivateClues] : [];
    const questionsChanged = !sameQuestionIds(recipientQuestionsBefore, recipientQuestionIds);
    const hasVisibleEffect =
      visibleDialogue !== null ||
      newPublicClues.length > 0 ||
      privateClues.length > 0 ||
      questionsChanged;

    if (!hasVisibleEffect) {
      return { recipientUserId, event: null };
    }

    const event: GameEvent = GameEventSchema.parse({
      eventId,
      sessionId: state.sessionId,
      version: state.version,
      type: 'suspect.answered',
      occurredAt,
      payload: {
        dialogue: visibleDialogue,
        newPublicClues,
        newPrivateClues: privateClues,
        availableQuestions: recipientQuestions,
        phase: 'investigating',
      },
    });
    return { recipientUserId, event };
  });
}
