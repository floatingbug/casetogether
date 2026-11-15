import { describe, expect, it } from 'vitest';
import { GameEventSchema } from '@casetogether/shared';
import { STILLER_GLOCKENSCHLAG_CASE, glockenschlagIds } from '../../src/game-engine/index.js';
import { answer, finish, runEvidencePath, snapshot, startState, testUsers } from './helpers.js';

describe('complete curated case traversal', () => {
  it('actually reaches and answers every catalog question using only produced availability', () => {
    let state = startState(2, 'all-questions');
    const answered = new Set<string>();
    const dialogueIds = new Set<string>();
    const eventIds = new Set<string>();
    let actionSequence = 200;

    while (answered.size < STILLER_GLOCKENSCHLAG_CASE.questions.length) {
      const available = snapshot(state).availableQuestions.filter(
        (question) => !answered.has(question.questionId),
      );
      expect(
        available.length,
        `No reachable question after ${answered.size} answers`,
      ).toBeGreaterThan(0);
      const next = available[0];
      if (next === undefined) {
        throw new Error('Reachable catalog unexpectedly exhausted');
      }
      const previousVersion = state.version;
      const command = answer(state, testUsers.host.id, next.questionId, actionSequence);
      actionSequence += 1;
      state = command.state;
      answered.add(next.questionId);
      eventIds.add(command.eventId);
      expect(command.state.version).toBe(previousVersion + 1);
      expect(command.replayed).toBe(false);

      const dialogue = snapshot(state).dialogues.find(
        (candidate) => candidate.questionId === next.questionId,
      );
      const definition = STILLER_GLOCKENSCHLAG_CASE.questions.find(
        (candidate) => candidate.questionId === next.questionId,
      );
      expect(dialogue).toBeDefined();
      expect(dialogue?.answerText).toBe(definition?.referenceAnswer);
      expect(dialogue?.answerSource).toBe('reference');
      expect(definition?.text.length).toBeGreaterThan(25);
      expect(definition?.referenceAnswer.length).toBeGreaterThan(80);
      if (dialogue !== undefined) {
        dialogueIds.add(dialogue.id);
      }
      const event = command.recipientEvents.find(
        (recipient) => recipient.recipientUserId === testUsers.host.id,
      )?.event;
      expect(event).not.toBeNull();
      if (event !== null && event !== undefined) {
        expect(GameEventSchema.parse(event)).toEqual(event);
      }
    }

    expect(answered).toEqual(
      new Set(STILLER_GLOCKENSCHLAG_CASE.questions.map((question) => question.questionId)),
    );
    expect(answered.size).toBe(12);
    expect(dialogueIds.size).toBe(12);
    expect(eventIds.size).toBe(12);
    expect(
      snapshot(state).dialogues.every((dialogue) => dialogue.answerSource === 'reference'),
    ).toBe(true);
    for (const requiredId of STILLER_GLOCKENSCHLAG_CASE.truth.requiredEvidenceClueIds) {
      const visible =
        snapshot(state).publicClues.some((clue) => clue.id === requiredId) ||
        snapshot(state).privateClues.some((clue) => clue.id === requiredId);
      expect(visible, `Required clue ${requiredId} was not traversed`).toBe(true);
    }
    const final = finish(state, testUsers.host.id, glockenschlagIds.suspects.miriam, 300);
    expect(final.state.result).toMatchObject({
      verdict: 'correct',
      awardedPoints: 100,
      maximumPoints: 100,
    });
  });

  it('counts duplicate private discoveries by different members only once in group scoring', () => {
    const path = runEvidencePath(startState(2, 'duplicate-private'));
    let state = path.state;
    state = answer(state, testUsers.guest.id, glockenschlagIds.questions.jonasRound, 310).state;
    state = answer(state, testUsers.guest.id, glockenschlagIds.questions.jonasInventory, 311).state;
    state = answer(state, testUsers.guest.id, glockenschlagIds.questions.miriamTea, 312).state;
    state = answer(
      state,
      testUsers.guest.id,
      glockenschlagIds.questions.miriamConcentrate,
      313,
    ).state;
    expect(
      state.revealedClues.filter((clue) => clue.clue.id === glockenschlagIds.clues.solventCheckout),
    ).toHaveLength(2);
    expect(
      state.revealedClues.filter(
        (clue) => clue.clue.id === glockenschlagIds.clues.concentrateMatch,
      ),
    ).toHaveLength(2);
    expect(snapshot(state, testUsers.guest.id).privateClues).toHaveLength(2);
    expect(snapshot(state).privateClues).toHaveLength(2);
    const final = finish(state, testUsers.host.id, glockenschlagIds.suspects.miriam, 314);
    expect(final.state.result).toMatchObject({
      verdict: 'correct',
      awardedPoints: 100,
      maximumPoints: 100,
    });
  });

  it.each(['jonas', 'selin'] as const)(
    'cannot turn complete evidence for Miriam into a correct conviction of %s',
    (alternative) => {
      const path = runEvidencePath(startState(2, `uniqueness-${alternative}`));
      const final = finish(
        path.state,
        testUsers.host.id,
        glockenschlagIds.suspects[alternative],
        320,
      );
      expect(final.state.result).toMatchObject({
        verdict: 'incorrect',
        awardedPoints: 60,
        maximumPoints: 100,
        resolution: STILLER_GLOCKENSCHLAG_CASE.truth.resolution,
      });
    },
  );
});
