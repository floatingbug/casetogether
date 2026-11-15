import { describe, expect, it } from 'vitest';
import {
  GameCompletedEventSchema,
  GameEventSchema,
  GameSnapshotSchema,
  type GameSnapshot,
  type SuspectAnsweredEvent,
} from '@casetogether/shared';
import { STILLER_GLOCKENSCHLAG_CASE, glockenschlagIds } from '../../src/game-engine/index.js';
import {
  SUCCESS_QUESTION_SEQUENCE,
  abandon,
  answer,
  eventFor,
  nonNullEvent,
  runCompleteGame,
  runEvidencePath,
  snapshot,
  start,
  startState,
  testUsers,
} from './helpers.js';

function applyAnsweredDelta(current: GameSnapshot, event: SuspectAnsweredEvent): GameSnapshot {
  const dialogue = event.payload.dialogue;
  const publicClues = [...current.publicClues, ...event.payload.newPublicClues].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  const privateClues = [...current.privateClues, ...event.payload.newPrivateClues].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  const dialogues = [...current.dialogues, ...(dialogue === null ? [] : [dialogue])].sort(
    (left, right) => {
      const byDate = left.createdAt.localeCompare(right.createdAt);
      return byDate === 0 ? left.id.localeCompare(right.id) : byDate;
    },
  );
  return GameSnapshotSchema.parse({
    ...current,
    version: event.version,
    phase: event.payload.phase,
    availableQuestions: event.payload.availableQuestions,
    publicClues,
    privateClues,
    dialogues,
  });
}

describe('recipient-specific visibility and server secrets', () => {
  it('omits all truth, suspect secrets, triggers, clue texts and every unrevealed reference at start', () => {
    const started = start(4, 'initial-leaks');
    for (const member of started.state.members) {
      const serializedSnapshot = JSON.stringify(snapshot(started.state, member.user.id));
      const event = nonNullEvent(started, member.user.id);
      const serialized = `${serializedSnapshot}${JSON.stringify(event)}`;
      expect(serialized).not.toContain(STILLER_GLOCKENSCHLAG_CASE.truth.resolution.title);
      expect(serialized).not.toContain(STILLER_GLOCKENSCHLAG_CASE.truth.resolution.explanation);
      for (const definition of STILLER_GLOCKENSCHLAG_CASE.suspectDefinitions) {
        expect(serialized).not.toContain(definition.secret.concealedFact);
      }
      for (const question of STILLER_GLOCKENSCHLAG_CASE.questions) {
        expect(serialized).not.toContain(question.referenceAnswer);
      }
      for (const clue of STILLER_GLOCKENSCHLAG_CASE.clues) {
        expect(serialized).not.toContain(clue.text);
      }
      for (const forbiddenKey of [
        'culpritId',
        'referenceAnswer',
        'requiresQuestionIds',
        'concealedFact',
        'caseTruth',
        'actionReceipts',
        'payloadHash',
      ]) {
        expect(serialized).not.toContain(`"${forbiddenKey}"`);
      }
      expect(GameEventSchema.parse(event)).toEqual(event);
    }
  });

  it('projects actor-only inventory dialogue and clues only to the actor while allowing the public effect', () => {
    let state = startState(3);
    state = answer(state, testUsers.host.id, glockenschlagIds.questions.jonasRound, 20).state;
    const inventory = answer(
      state,
      testUsers.host.id,
      glockenschlagIds.questions.jonasInventory,
      21,
    );
    const host = snapshot(inventory.state, testUsers.host.id);
    const guest = snapshot(inventory.state, testUsers.guest.id);
    const third = snapshot(inventory.state, testUsers.third.id);
    const privateReference = STILLER_GLOCKENSCHLAG_CASE.questions.find(
      (question) => question.questionId === glockenschlagIds.questions.jonasInventory,
    )?.referenceAnswer;
    const privateClue = STILLER_GLOCKENSCHLAG_CASE.clues.find(
      (clue) => clue.id === glockenschlagIds.clues.solventCheckout,
    )?.text;
    if (privateReference === undefined || privateClue === undefined) {
      throw new Error('Private leak fixtures must exist');
    }

    expect(host.privateClues.map((clue) => clue.id)).toEqual([
      glockenschlagIds.clues.solventCheckout,
    ]);
    expect(host.dialogues.some((dialogue) => dialogue.answerText === privateReference)).toBe(true);
    expect(guest.privateClues).toEqual([]);
    expect(third.privateClues).toEqual([]);
    expect(guest.publicClues.map((clue) => clue.id)).toContain(
      glockenschlagIds.clues.inventoryRecord,
    );

    const hostEvent = nonNullEvent(inventory, testUsers.host.id);
    if (hostEvent.type !== 'suspect.answered') {
      throw new Error('Expected suspect answer');
    }
    expect(hostEvent.payload.dialogue?.answerText).toBe(privateReference);
    expect(hostEvent.payload.newPrivateClues.map((clue) => clue.id)).toEqual([
      glockenschlagIds.clues.solventCheckout,
    ]);

    for (const recipient of [testUsers.guest, testUsers.third]) {
      const event = nonNullEvent(inventory, recipient.id);
      if (event.type !== 'suspect.answered') {
        throw new Error('Expected public effect projection');
      }
      expect(event.payload.dialogue).toBeNull();
      expect(event.payload.newPrivateClues).toEqual([]);
      expect(event.payload.newPublicClues.map((clue) => clue.id)).toEqual([
        glockenschlagIds.clues.inventoryRecord,
      ]);
      expect(event.payload.availableQuestions.map((question) => question.questionId)).not.toContain(
        glockenschlagIds.questions.jonasInventory,
      );
      const publicJson = JSON.stringify(event);
      const snapshotJson = JSON.stringify(snapshot(inventory.state, recipient.id));
      expect(publicJson).not.toContain(privateReference);
      expect(publicJson).not.toContain(privateClue);
      expect(snapshotJson).not.toContain(privateReference);
      expect(snapshotJson).not.toContain(privateClue);
      expect(GameEventSchema.parse(event)).toEqual(event);
    }
    expect(host.version).toBe(guest.version);
    expect(third.version).toBe(guest.version);
  });

  it('sends no event for a purely foreign private answer and permits only a version gap repair', () => {
    const prefix = runEvidencePath(
      startState(3, 'pure-private'),
      SUCCESS_QUESTION_SEQUENCE.slice(0, 5),
    );
    const privateAnswer = answer(
      prefix.state,
      testUsers.host.id,
      glockenschlagIds.questions.miriamConcentrate,
      60,
    );
    const privateReference = STILLER_GLOCKENSCHLAG_CASE.questions.find(
      (question) => question.questionId === glockenschlagIds.questions.miriamConcentrate,
    )?.referenceAnswer;
    const privateClue = STILLER_GLOCKENSCHLAG_CASE.clues.find(
      (clue) => clue.id === glockenschlagIds.clues.concentrateMatch,
    )?.text;
    if (privateReference === undefined || privateClue === undefined) {
      throw new Error('Private leak fixtures must exist');
    }
    expect(privateAnswer.state.version).toBe(prefix.state.version + 1);

    const hostEvent = nonNullEvent(privateAnswer, testUsers.host.id);
    if (hostEvent.type !== 'suspect.answered') {
      throw new Error('Expected a private suspect answer');
    }
    expect(hostEvent.payload.newPrivateClues.map((clue) => clue.id)).toEqual([
      glockenschlagIds.clues.concentrateMatch,
    ]);
    expect(hostEvent.payload.newPublicClues).toEqual([]);
    expect(hostEvent.payload.dialogue?.answerText).toBe(privateReference);

    for (const recipient of [testUsers.guest, testUsers.third]) {
      expect(eventFor(privateAnswer, recipient.id)).toBeNull();
      const repaired = snapshot(privateAnswer.state, recipient.id);
      const serialized = JSON.stringify(repaired);
      expect(repaired.version).toBe(privateAnswer.state.version);
      expect(repaired.privateClues).toEqual([]);
      expect(repaired.availableQuestions.map((question) => question.questionId)).not.toContain(
        glockenschlagIds.questions.miriamConcentrate,
      );
      expect(serialized).not.toContain(privateReference);
      expect(serialized).not.toContain(privateClue);
      expect(GameSnapshotSchema.parse(repaired)).toEqual(repaired);
    }
  });

  it('keeps private content separate after completed and hides resolution after abandoned', () => {
    const completed = runCompleteGame('terminal-visibility');
    const hostCompleted = nonNullEvent(completed.final, testUsers.host.id);
    const guestCompleted = nonNullEvent(completed.final, testUsers.guest.id);
    expect(GameCompletedEventSchema.parse(hostCompleted)).toEqual(hostCompleted);
    expect(GameCompletedEventSchema.parse(guestCompleted)).toEqual(guestCompleted);
    if (hostCompleted.type !== 'game.completed' || guestCompleted.type !== 'game.completed') {
      throw new Error('Expected completed snapshots');
    }
    expect(hostCompleted.payload.snapshot.result).toEqual(completed.state.result);
    expect(guestCompleted.payload.snapshot.result).toEqual(completed.state.result);
    expect(hostCompleted.payload.snapshot.privateClues).toHaveLength(2);
    expect(guestCompleted.payload.snapshot.privateClues).toHaveLength(0);

    const abandoned = abandon(startState(), 50);
    for (const member of abandoned.state.members) {
      const event = nonNullEvent(abandoned, member.user.id);
      const serialized = JSON.stringify(event);
      expect(event.type).toBe('game.abandoned');
      expect(serialized).not.toContain(STILLER_GLOCKENSCHLAG_CASE.truth.resolution.title);
      expect(serialized).not.toContain('"result":{"verdict"');
    }
  });

  it('validates every contiguous delta and repairs private version gaps only by snapshots', () => {
    const completed = runCompleteGame('event-chain');
    let hostLocal = snapshot(completed.path.initialState, testUsers.host.id);
    let guestLocal = snapshot(completed.path.initialState, testUsers.guest.id);
    const commands = [...completed.path.commands, completed.final];

    for (const command of commands) {
      for (const recipient of [testUsers.host, testUsers.guest]) {
        const event = eventFor(command, recipient.id);
        if (event === null) {
          continue;
        }
        let local = recipient.id === testUsers.host.id ? hostLocal : guestLocal;
        if (event.type === 'game.completed') {
          local = GameSnapshotSchema.parse(event.payload.snapshot);
        } else if (event.type === 'suspect.answered') {
          if (event.version > local.version + 1) {
            local = snapshot(command.state, recipient.id);
          } else {
            expect(event.version).toBe(local.version + 1);
            local = applyAnsweredDelta(local, event);
          }
        }
        expect(GameSnapshotSchema.parse(local)).toEqual(local);
        if (recipient.id === testUsers.host.id) {
          hostLocal = local;
        } else {
          guestLocal = local;
        }
      }
    }
    expect(hostLocal).toEqual(snapshot(completed.state, testUsers.host.id));
    expect(guestLocal).toEqual(snapshot(completed.state, testUsers.guest.id));
  });
});
