import { describe, expect, it } from 'vitest';
import {
  GameAbandonedEventSchema,
  GameStartedEventSchema,
  GameSnapshotSchema,
  StartGameRequestSchema,
} from '@casetogether/shared';
import {
  STILLER_GLOCKENSCHLAG_CASE,
  abandonGame,
  askCatalogQuestion,
  glockenschlagIds,
  startGame,
  submitFinalSolution,
  type AbandonGameCommand,
} from '../../src/game-engine/index.js';
import {
  OUTSIDER_ID,
  abandon,
  catalogRequest,
  finalRequest,
  makeStartContext,
  mustFailure,
  nonNullEvent,
  snapshot,
  start,
  startState,
  testUsers,
  time,
} from './helpers.js';

describe('game start lifecycle', () => {
  it.each([0, 1, 5, 6])('rejects an unsupported member count of %i without a session', (count) => {
    const context = makeStartContext(2, `members-${count}`);
    const members = makeStartContext(count, `members-${count}`).members;
    const before = JSON.stringify(members);
    const result = startGame(STILLER_GLOCKENSCHLAG_CASE, { ...context, members });
    expect(mustFailure(result).code).toBe('INVALID_STATE_TRANSITION');
    expect(JSON.stringify(members)).toBe(before);
  });

  it.each([2, 3, 4])('starts %i members directly in investigating at version 1', (count) => {
    const started = start(count, `valid-${count}`);
    const projected = snapshot(started.state);
    expect(projected.phase).toBe('investigating');
    expect(projected.version).toBe(1);
    expect(projected.members).toHaveLength(count);
    expect(projected.finalSubmission).toBeNull();
    expect(projected.result).toBeNull();
    expect(projected.finishedAt).toBeNull();
    expect(projected.startedAt).toBe(time(1));
    expect(GameSnapshotSchema.parse(projected)).toEqual(projected);

    for (const member of projected.members) {
      const event = nonNullEvent(started, member.user.id);
      expect(event.type).toBe('game.started');
      expect(event.version).toBe(1);
      expect(GameStartedEventSchema.parse(event)).toEqual(event);
    }
    expect(JSON.stringify(projected)).not.toContain('waiting');
    expect(JSON.stringify(projected)).not.toContain('ready');
  });

  it('derives host authorization from server membership and rejects client role fields', () => {
    const context = makeStartContext();
    const nonHost = startGame(STILLER_GLOCKENSCHLAG_CASE, {
      ...context,
      actorUserId: testUsers.guest.id,
    });
    expect(mustFailure(nonHost).code).toBe('FORBIDDEN');
    expect(StartGameRequestSchema.safeParse({ ...context.request, role: 'host' }).success).toBe(
      false,
    );
    expect(
      StartGameRequestSchema.safeParse({ ...context.request, submittedBy: testUsers.host.id })
        .success,
    ).toBe(false);
  });

  it('rejects non-members, non-ready rooms and stale room versions', () => {
    const context = makeStartContext();
    expect(
      mustFailure(startGame(STILLER_GLOCKENSCHLAG_CASE, { ...context, actorUserId: OUTSIDER_ID }))
        .code,
    ).toBe('NOT_FOUND');
    expect(
      mustFailure(startGame(STILLER_GLOCKENSCHLAG_CASE, { ...context, roomStatus: 'waiting' }))
        .code,
    ).toBe('INVALID_STATE_TRANSITION');
    const stale = mustFailure(
      startGame(STILLER_GLOCKENSCHLAG_CASE, {
        ...context,
        request: { ...context.request, expectedVersion: 6 },
      }),
    );
    expect(stale.code).toBe('VERSION_CONFLICT');
    expect(stale.details).toEqual({ currentVersion: 7 });
  });
});

describe('server-side abandonment', () => {
  it.each(['expired', 'server_timeout'] as const)(
    'creates a complete abandoned snapshot for explicit %s expiry',
    (reason) => {
      const initial = startState(3, `abandon-${reason}`);
      const abandoned = abandon(initial, 50, { reason });
      expect(abandoned.state.version).toBe(initial.version + 1);
      expect(abandoned.state.phase).toBe('abandoned');
      expect(abandoned.state.result).toBeNull();
      expect(abandoned.state.finalSubmission).toBeNull();
      expect(abandoned.state.finishedAt).toBe(time(50));
      const projected = snapshot(abandoned.state);
      expect(projected.availableQuestions).toEqual([]);
      expect(projected.result).toBeNull();
      for (const member of projected.members) {
        const event = nonNullEvent(abandoned, member.user.id);
        expect(event.type).toBe('game.abandoned');
        expect(GameAbandonedEventSchema.parse(event)).toEqual(event);
      }
    },
  );

  it('rejects a client-style abandonment reason at the server-job boundary', () => {
    const initial = startState();
    // This assertion intentionally models an unvalidated scheduler/job payload at the trust boundary.
    const untrustedJob = JSON.parse(
      '{"reason":"client_quit","expectedVersion":1,"occurredAt":"2026-11-15T20:00:40.000Z"}',
    ) as AbandonGameCommand;
    const before = JSON.stringify(initial);
    const error = mustFailure(abandonGame(STILLER_GLOCKENSCHLAG_CASE, initial, untrustedJob));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(initial)).toBe(before);
  });

  it('checks the expected version and remains immutable afterward', () => {
    const initial = startState();
    const staleBefore = JSON.stringify(initial);
    const stale = mustFailure(
      abandonGame(STILLER_GLOCKENSCHLAG_CASE, initial, {
        reason: 'expired',
        expectedVersion: initial.version + 1,
        occurredAt: time(40),
      }),
    );
    expect(stale).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 1 } });
    expect(JSON.stringify(initial)).toBe(staleBefore);

    const abandoned = abandon(initial, 41);
    const abandonedBefore = JSON.stringify(abandoned.state);
    const question = mustFailure(
      askCatalogQuestion(
        STILLER_GLOCKENSCHLAG_CASE,
        abandoned.state,
        testUsers.host.id,
        catalogRequest(abandoned.state, glockenschlagIds.questions.jonasRound, 55),
        time(55),
      ),
    );
    expect(question.code).toBe('INVALID_STATE_TRANSITION');
    const finalAttempt = mustFailure(
      submitFinalSolution(
        STILLER_GLOCKENSCHLAG_CASE,
        abandoned.state,
        testUsers.host.id,
        finalRequest(abandoned.state, glockenschlagIds.suspects.miriam, 56),
        time(56),
      ),
    );
    expect(finalAttempt.code).toBe('INVALID_STATE_TRANSITION');
    const again = mustFailure(
      abandonGame(STILLER_GLOCKENSCHLAG_CASE, abandoned.state, {
        reason: 'server_timeout',
        expectedVersion: abandoned.state.version,
        occurredAt: time(42),
      }),
    );
    expect(again.code).toBe('INVALID_STATE_TRANSITION');
    expect(JSON.stringify(abandoned.state)).toBe(abandonedBefore);
  });
});
