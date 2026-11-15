import { describe, expect, it } from 'vitest';
import {
  GameCompletedEventSchema,
  GameSnapshotSchema,
  SuspectIdSchema,
} from '@casetogether/shared';
import {
  STILLER_GLOCKENSCHLAG_CASE,
  askCatalogQuestion,
  submitFinalSolution,
} from '../../src/game-engine/index.js';
import { glockenschlagIds } from '../../src/game-engine/index.js';
import {
  SUCCESS_QUESTION_SEQUENCE,
  answer,
  catalogRequest,
  finalRequest,
  finish,
  mustFailure,
  nonNullEvent,
  runCompleteGame,
  runEvidencePath,
  snapshot,
  startState,
  testUsers,
  time,
} from './helpers.js';

describe('final submission and canonical scoring', () => {
  it('completes the full catalog-to-resolution journey with all six proof clues', () => {
    const { path, final, state } = runCompleteGame('full-success');
    expect(path.commands).toHaveLength(9);
    expect(path.state.version).toBe(10);
    expect(path.initialState.version).toBe(1);
    expect(path.commands.every((command) => !command.replayed)).toBe(true);

    const beforeFinal = snapshot(path.state);
    expect(beforeFinal.result).toBeNull();
    expect(beforeFinal.finalSubmission).toBeNull();
    expect(beforeFinal.finishedAt).toBeNull();
    const publicClueIds = new Set(beforeFinal.publicClues.map((clue) => clue.id));
    const privateClueIds = new Set(beforeFinal.privateClues.map((clue) => clue.id));
    for (const requiredId of STILLER_GLOCKENSCHLAG_CASE.truth.requiredEvidenceClueIds) {
      expect(publicClueIds.has(requiredId) || privateClueIds.has(requiredId)).toBe(true);
    }
    expect(beforeFinal.dialogues).toHaveLength(9);
    expect(beforeFinal.dialogues.every((dialogue) => dialogue.answerSource === 'reference')).toBe(
      true,
    );

    expect(state.phase).toBe('completed');
    expect(state.version).toBe(11);
    expect(state.finishedAt).toBe(time(90));
    expect(state.result).toMatchObject({
      verdict: 'correct',
      awardedPoints: 100,
      maximumPoints: 100,
      resolution: STILLER_GLOCKENSCHLAG_CASE.truth.resolution,
    });
    expect(state.result?.feedback).toContain('6 von 6');
    expect(state.finalSubmission).toMatchObject({
      suspectId: glockenschlagIds.suspects.miriam,
      submittedBy: testUsers.guest,
      submittedAt: time(90),
    });

    const projected = snapshot(state, testUsers.guest.id);
    expect(projected.result).toEqual(state.result);
    expect(projected.availableQuestions).toEqual([]);
    expect(GameSnapshotSchema.parse(projected)).toEqual(projected);
    for (const member of projected.members) {
      const event = nonNullEvent(final, member.user.id);
      expect(event.type).toBe('game.completed');
      expect(GameCompletedEventSchema.parse(event)).toEqual(event);
    }
  });

  it('returns incorrect with zero evidence points for an unsupported wrong conviction', () => {
    const initial = startState();
    expect(snapshot(initial).result).toBeNull();
    const completed = finish(initial, testUsers.host.id, glockenschlagIds.suspects.jonas, 60);
    expect(completed.state.phase).toBe('completed');
    expect(completed.state.version).toBe(2);
    expect(completed.state.result).toMatchObject({
      verdict: 'incorrect',
      awardedPoints: 0,
      maximumPoints: 100,
      resolution: STILLER_GLOCKENSCHLAG_CASE.truth.resolution,
    });
    expect(completed.state.result?.feedback).toContain('0 von 6');
    expect(nonNullEvent(completed, testUsers.guest.id).type).toBe('game.completed');
  });

  it('allows a correct early conviction but awards only the forty verdict points', () => {
    const initial = startState();
    const completed = finish(initial, testUsers.guest.id, glockenschlagIds.suspects.miriam, 60);
    expect(completed.state.result).toMatchObject({
      verdict: 'correct',
      awardedPoints: 40,
      maximumPoints: 100,
    });
    expect(completed.state.result?.feedback).toContain('0 von 6');
  });

  it.each([
    { prefixLength: 3, evidence: 1, points: 50 },
    { prefixLength: 4, evidence: 1, points: 50 },
    { prefixLength: 5, evidence: 2, points: 60 },
    { prefixLength: 6, evidence: 3, points: 70 },
    { prefixLength: 7, evidence: 4, points: 80 },
    { prefixLength: 8, evidence: 5, points: 90 },
    { prefixLength: 9, evidence: 6, points: 100 },
  ])(
    'awards exactly $points points after $evidence required clues on the traversed path',
    ({ prefixLength, evidence, points }) => {
      const initial = startState(2, `score-${prefixLength}`);
      const path = runEvidencePath(initial, SUCCESS_QUESTION_SEQUENCE.slice(0, prefixLength));
      const completed = finish(path.state, testUsers.host.id, glockenschlagIds.suspects.miriam, 80);
      expect(completed.state.result?.feedback).toContain(`${evidence} von 6`);
      expect(completed.state.result).toMatchObject({
        verdict: 'correct',
        awardedPoints: points,
        maximumPoints: 100,
      });
    },
  );

  it('retains canonical evidence scoring on an incorrect final submission', () => {
    let state = startState();
    state = answer(state, testUsers.host.id, glockenschlagIds.questions.jonasRound, 20).state;
    state = answer(state, testUsers.host.id, glockenschlagIds.questions.jonasInventory, 21).state;
    expect(snapshot(state).privateClues).toHaveLength(1);
    const completed = finish(state, testUsers.guest.id, glockenschlagIds.suspects.selin, 60);
    expect(completed.state.result).toMatchObject({
      verdict: 'incorrect',
      awardedPoints: 10,
      maximumPoints: 100,
    });
  });

  it('rejects an unknown final suspect without changing state', () => {
    const initial = startState();
    const before = JSON.stringify(initial);
    const result = submitFinalSolution(
      STILLER_GLOCKENSCHLAG_CASE,
      initial,
      testUsers.host.id,
      finalRequest(initial, SuspectIdSchema.parse('suspect-outside-the-case'), 70),
      time(70),
    );
    expect(mustFailure(result).code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(initial)).toBe(before);
  });

  it('leaves a completed game immutable for new questions and new final submissions', () => {
    const completed = runCompleteGame('immutable-completed');
    const before = JSON.stringify(completed.state);
    const question = mustFailure(
      askCatalogQuestion(
        STILLER_GLOCKENSCHLAG_CASE,
        completed.state,
        testUsers.host.id,
        catalogRequest(completed.state, glockenschlagIds.questions.jonasRound, 100),
        time(100),
      ),
    );
    expect(question.code).toBe('INVALID_STATE_TRANSITION');
    const newFinal = mustFailure(
      submitFinalSolution(
        STILLER_GLOCKENSCHLAG_CASE,
        completed.state,
        testUsers.host.id,
        finalRequest(completed.state, glockenschlagIds.suspects.jonas, 101),
        time(101),
      ),
    );
    expect(newFinal.code).toBe('INVALID_STATE_TRANSITION');
    expect(JSON.stringify(completed.state)).toBe(before);
  });

  it('models competing finals with exactly one CAS-compatible winner and one stale loser', () => {
    const base = runEvidencePath(startState(2, 'parallel-final')).state;
    const winnerRequest = finalRequest(base, glockenschlagIds.suspects.miriam, 110);
    const loserRequest = finalRequest(base, glockenschlagIds.suspects.jonas, 111);
    const before = JSON.stringify(base);

    const winner = finish(base, testUsers.guest.id, glockenschlagIds.suspects.miriam, 110);
    const loser = mustFailure(
      submitFinalSolution(
        STILLER_GLOCKENSCHLAG_CASE,
        winner.state,
        testUsers.host.id,
        loserRequest,
        time(111),
      ),
    );
    expect(winnerRequest.expectedVersion).toBe(winner.state.version - 1);
    expect(loser).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: winner.state.version },
    });
    expect(winner.state.version).toBe(base.version + 1);
    expect(winner.state.phase).toBe('completed');
    expect(JSON.stringify(base)).toBe(before);
  });
});
