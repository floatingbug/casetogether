import { describe, expect, it } from 'vitest';
import {
  GameEventSchema,
  QuestionIdSchema,
  SuspectAnsweredEventSchema,
  SuspectIdSchema,
} from '@casetogether/shared';
import {
  STILLER_GLOCKENSCHLAG_CASE,
  askCatalogQuestion,
  glockenschlagIds,
} from '../../src/game-engine/index.js';
import {
  OUTSIDER_ID,
  answer,
  catalogRequest,
  mustFailure,
  nonNullEvent,
  snapshot,
  startState,
  testUsers,
  time,
} from './helpers.js';

function questionIds(state: Parameters<typeof snapshot>[0], actor = testUsers.host.id) {
  return snapshot(state, actor).availableQuestions.map((question) => question.questionId);
}

describe('catalog question validation and transitions', () => {
  it('starts with four curated questions and hides every locked follow-up', () => {
    const state = startState();
    expect(new Set(questionIds(state))).toEqual(
      new Set([
        glockenschlagIds.questions.miriamEvening,
        glockenschlagIds.questions.jonasRound,
        glockenschlagIds.questions.jonasTeacup,
        glockenschlagIds.questions.selinProgram,
      ]),
    );
    const visible = new Set(questionIds(state));
    for (const question of STILLER_GLOCKENSCHLAG_CASE.questions) {
      if (question.requiresQuestionIds.length > 0) {
        expect(visible.has(question.questionId)).toBe(false);
      }
    }
  });

  it('answers a visible room question with its exact reference and unlocks actor-specific follow-ups', () => {
    const initial = startState(3);
    const answered = answer(initial, testUsers.host.id, glockenschlagIds.questions.jonasRound, 20);
    expect(answered.replayed).toBe(false);
    expect(answered.state.version).toBe(2);
    expect(answered.state.phase).toBe('investigating');
    expect(initial.version).toBe(1);

    const hostSnapshot = snapshot(answered.state);
    const hostDialogue = hostSnapshot.dialogues[0];
    expect(hostDialogue).toMatchObject({
      suspectId: glockenschlagIds.suspects.jonas,
      questionId: glockenschlagIds.questions.jonasRound,
      mode: 'catalog',
      answerSource: 'reference',
      createdAt: time(20),
    });
    const reference = STILLER_GLOCKENSCHLAG_CASE.questions.find(
      (question) => question.questionId === glockenschlagIds.questions.jonasRound,
    );
    expect(hostDialogue?.answerText).toBe(reference?.referenceAnswer);
    expect(hostSnapshot.publicClues.map((clue) => clue.id)).toContain(
      glockenschlagIds.clues.serviceCorridor,
    );
    expect(questionIds(answered.state)).toContain(glockenschlagIds.questions.jonasInventory);
    expect(questionIds(answered.state, testUsers.guest.id)).not.toContain(
      glockenschlagIds.questions.jonasInventory,
    );
    expect(questionIds(answered.state, testUsers.third.id)).not.toContain(
      glockenschlagIds.questions.jonasInventory,
    );

    for (const member of hostSnapshot.members) {
      const event = nonNullEvent(answered, member.user.id);
      expect(event.type).toBe('suspect.answered');
      expect(event.version).toBe(2);
      expect(SuspectAnsweredEventSchema.parse(event)).toEqual(event);
      expect(GameEventSchema.parse(event)).toEqual(event);
    }
  });

  it('lets another actor independently traverse the private prerequisite chain', () => {
    let state = startState();
    state = answer(state, testUsers.host.id, glockenschlagIds.questions.jonasRound, 20).state;
    expect(questionIds(state, testUsers.guest.id)).not.toContain(
      glockenschlagIds.questions.jonasInventory,
    );
    state = answer(state, testUsers.guest.id, glockenschlagIds.questions.jonasRound, 21).state;
    expect(questionIds(state, testUsers.guest.id)).toContain(
      glockenschlagIds.questions.jonasInventory,
    );
    state = answer(state, testUsers.guest.id, glockenschlagIds.questions.jonasInventory, 22).state;
    expect(snapshot(state, testUsers.guest.id).privateClues.map((clue) => clue.id)).toContain(
      glockenschlagIds.clues.solventCheckout,
    );
    expect(snapshot(state).privateClues).toEqual([]);
  });

  it('deduplicates clues for new requests while preserving reference dialogues and version rules', () => {
    const initial = startState();
    const first = answer(initial, testUsers.host.id, glockenschlagIds.questions.jonasRound, 20);
    const second = answer(
      first.state,
      testUsers.host.id,
      glockenschlagIds.questions.jonasRound,
      21,
    );
    expect(second.state.version).toBe(3);
    expect(snapshot(second.state).publicClues.map((clue) => clue.id)).toEqual([
      glockenschlagIds.clues.serviceCorridor,
    ]);
    expect(snapshot(second.state).dialogues).toHaveLength(2);
    const event = nonNullEvent(second, testUsers.host.id);
    if (event.type !== 'suspect.answered') {
      throw new Error('Expected a suspect answer');
    }
    expect(event.payload.newPublicClues).toEqual([]);
    expect(event.payload.newPrivateClues).toEqual([]);
    const firstEvent = nonNullEvent(first, testUsers.host.id);
    if (firstEvent.type !== 'suspect.answered') {
      throw new Error('Expected the first suspect answer');
    }
    expect(event.payload.dialogue?.id).not.toBe(firstEvent.payload.dialogue?.id);
  });

  it.each(['unknown-question', 'wrong-suspect', 'unknown-suspect', 'locked-question'])(
    'rejects %s without changing the prior state',
    (caseName) => {
      const initial = startState();
      let request = catalogRequest(initial, glockenschlagIds.questions.jonasRound, 30);
      if (caseName === 'unknown-question') {
        request = { ...request, questionId: QuestionIdSchema.parse('q-does-not-exist') };
      }
      if (caseName === 'wrong-suspect') {
        request = { ...request, suspectId: glockenschlagIds.suspects.selin };
      }
      if (caseName === 'unknown-suspect') {
        request = { ...request, suspectId: SuspectIdSchema.parse('suspect-unknown') };
      }
      if (caseName === 'locked-question') {
        request = catalogRequest(initial, glockenschlagIds.questions.miriamConcentrate, 30);
      }
      const before = JSON.stringify(initial);
      const error = mustFailure(
        askCatalogQuestion(
          STILLER_GLOCKENSCHLAG_CASE,
          initial,
          testUsers.host.id,
          request,
          time(30),
        ),
      );
      expect(error).toEqual({
        code: 'QUESTION_NOT_AVAILABLE',
        message: 'Diese Katalogfrage ist für diesen Verdächtigen oder Spieler nicht verfügbar.',
      });
      expect(JSON.stringify(error)).not.toContain('referenceAnswer');
      expect(JSON.stringify(error)).not.toContain('requiresQuestionIds');
      expect(JSON.stringify(initial)).toBe(before);
    },
  );

  it('rejects a non-member before evaluating the question and does not mutate state', () => {
    const initial = startState();
    const before = JSON.stringify(initial);
    const result = askCatalogQuestion(
      STILLER_GLOCKENSCHLAG_CASE,
      initial,
      OUTSIDER_ID,
      catalogRequest(initial, glockenschlagIds.questions.jonasRound, 40),
      time(40),
    );
    expect(mustFailure(result).code).toBe('NOT_FOUND');
    expect(JSON.stringify(initial)).toBe(before);
  });
});
