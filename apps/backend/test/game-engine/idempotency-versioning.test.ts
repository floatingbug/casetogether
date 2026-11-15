import { describe, expect, it } from 'vitest';
import {
  STILLER_GLOCKENSCHLAG_CASE,
  askCatalogQuestion,
  glockenschlagIds,
  submitFinalSolution,
} from '../../src/game-engine/index.js';
import {
  answer,
  catalogRequest,
  finalRequest,
  must,
  mustFailure,
  snapshot,
  startState,
  testUsers,
  time,
} from './helpers.js';

describe('deterministic idempotency and expected versions', () => {
  it('replays a catalog command after later mutations without a new dialogue, clue, event or version', () => {
    const initial = startState();
    const firstRequest = catalogRequest(initial, glockenschlagIds.questions.jonasRound, 20);
    const first = must(
      askCatalogQuestion(
        STILLER_GLOCKENSCHLAG_CASE,
        initial,
        testUsers.host.id,
        firstRequest,
        time(20),
      ),
    );
    const later = answer(
      first.state,
      testUsers.guest.id,
      glockenschlagIds.questions.selinProgram,
      21,
    );
    const before = JSON.stringify(later.state);
    const dialoguesBefore = snapshot(later.state).dialogues.length;
    const cluesBefore = snapshot(later.state).publicClues.length;
    const eventsBefore = later.state.events.length;
    const receiptsBefore = later.state.receipts.length;

    const replay = must(
      askCatalogQuestion(
        STILLER_GLOCKENSCHLAG_CASE,
        later.state,
        testUsers.host.id,
        firstRequest,
        time(999),
      ),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.state).toBe(later.state);
    expect(replay.eventId).toBe(first.eventId);
    expect(replay.recipientEvents).toEqual(first.recipientEvents);
    expect(replay.state.version).toBe(later.state.version);
    expect(snapshot(replay.state).dialogues).toHaveLength(dialoguesBefore);
    expect(snapshot(replay.state).publicClues).toHaveLength(cluesBefore);
    expect(replay.state.events).toHaveLength(eventsBefore);
    expect(replay.state.receipts).toHaveLength(receiptsBefore);
    expect(JSON.stringify(later.state)).toBe(before);
  });

  it('returns the logically identical immediate replay except for non-broadcast metadata', () => {
    const initial = startState();
    const request = catalogRequest(initial, glockenschlagIds.questions.jonasRound, 20);
    const original = must(
      askCatalogQuestion(STILLER_GLOCKENSCHLAG_CASE, initial, testUsers.host.id, request, time(20)),
    );
    const replay = must(
      askCatalogQuestion(
        STILLER_GLOCKENSCHLAG_CASE,
        original.state,
        testUsers.host.id,
        request,
        time(21),
      ),
    );
    expect(JSON.stringify({ ...replay, replayed: false })).toBe(JSON.stringify(original));
  });

  it('rejects the same question key with a changed payload and preserves the successful original', () => {
    const original = answer(
      startState(),
      testUsers.host.id,
      glockenschlagIds.questions.jonasRound,
      20,
    );
    const before = JSON.stringify(original.state);
    const changed = catalogRequest(original.state, glockenschlagIds.questions.selinProgram, 999, {
      clientRequestId: '00000000-0000-4000-8000-000000000020',
      expectedVersion: original.state.version,
    });
    const error = mustFailure(
      askCatalogQuestion(
        STILLER_GLOCKENSCHLAG_CASE,
        original.state,
        testUsers.host.id,
        changed,
        time(30),
      ),
    );
    expect(error).toEqual({
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'Diese Anfrage-ID wurde bereits mit einem anderen Inhalt verwendet.',
    });
    expect(JSON.stringify(original.state)).toBe(before);
  });

  it('replays the final snapshot and result exactly without a second mutation', () => {
    const initial = startState();
    const request = finalRequest(initial, glockenschlagIds.suspects.miriam, 50);
    const original = must(
      submitFinalSolution(
        STILLER_GLOCKENSCHLAG_CASE,
        initial,
        testUsers.guest.id,
        request,
        time(50),
      ),
    );
    const before = JSON.stringify(original.state);
    const replay = must(
      submitFinalSolution(
        STILLER_GLOCKENSCHLAG_CASE,
        original.state,
        testUsers.guest.id,
        request,
        time(999),
      ),
    );
    expect(replay.replayed).toBe(true);
    expect(JSON.stringify({ ...replay, replayed: false })).toBe(JSON.stringify(original));
    expect(replay.state.phase).toBe('completed');
    expect(replay.state.finishedAt).toBe(time(50));
    expect(replay.state.result).toBe(original.state.result);
    expect(JSON.stringify(original.state)).toBe(before);

    const changed = mustFailure(
      submitFinalSolution(
        STILLER_GLOCKENSCHLAG_CASE,
        original.state,
        testUsers.guest.id,
        { ...request, suspectId: glockenschlagIds.suspects.jonas },
        time(1000),
      ),
    );
    expect(changed.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(JSON.stringify(original.state)).toBe(before);
  });

  it('keeps client request scopes separate by actor and operation without ID collisions', () => {
    const initial = startState();
    const sharedKey = '00000000-0000-4000-8000-000000000060';
    const host = answer(initial, testUsers.host.id, glockenschlagIds.questions.jonasRound, 61);
    // Rebuild with the same key to demonstrate actor scoping instead of relying on generated sequence IDs.
    const hostReplayedWithSharedKey = must(
      askCatalogQuestion(
        STILLER_GLOCKENSCHLAG_CASE,
        initial,
        testUsers.host.id,
        catalogRequest(initial, glockenschlagIds.questions.jonasRound, 61, {
          clientRequestId: sharedKey,
        }),
        time(61),
      ),
    );
    const guest = must(
      askCatalogQuestion(
        STILLER_GLOCKENSCHLAG_CASE,
        hostReplayedWithSharedKey.state,
        testUsers.guest.id,
        catalogRequest(hostReplayedWithSharedKey.state, glockenschlagIds.questions.jonasRound, 62, {
          clientRequestId: sharedKey,
        }),
        time(62),
      ),
    );
    expect(hostReplayedWithSharedKey.eventId).not.toBe(guest.eventId);
    const hostDialogue = snapshot(hostReplayedWithSharedKey.state).dialogues[0];
    const guestDialogue = snapshot(guest.state, testUsers.guest.id).dialogues.find(
      (dialogue) => dialogue.askedBy.id === testUsers.guest.id,
    );
    expect(guestDialogue?.id).not.toBe(hostDialogue?.id);

    const final = must(
      submitFinalSolution(
        STILLER_GLOCKENSCHLAG_CASE,
        guest.state,
        testUsers.host.id,
        finalRequest(guest.state, glockenschlagIds.suspects.miriam, 63, {
          clientRequestId: sharedKey,
        }),
        time(63),
      ),
    );
    expect(final.state.phase).toBe('completed');
    expect(final.eventId).not.toBe(host.eventId);
  });

  it('creates no receipt for stale or unauthorized attempts and leaves state unchanged on conflicts', () => {
    const initial = startState();
    const sharedKey = '00000000-0000-4000-8000-000000000070';
    const before = JSON.stringify(initial);
    const staleRequest = catalogRequest(initial, glockenschlagIds.questions.jonasRound, 71, {
      clientRequestId: sharedKey,
      expectedVersion: 99,
    });
    const stale = mustFailure(
      askCatalogQuestion(
        STILLER_GLOCKENSCHLAG_CASE,
        initial,
        testUsers.host.id,
        staleRequest,
        time(71),
      ),
    );
    expect(stale).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 1 } });
    expect(initial.receipts).toEqual([]);
    expect(initial.events).toHaveLength(1);
    expect(JSON.stringify(initial)).toBe(before);

    const accepted = must(
      askCatalogQuestion(
        STILLER_GLOCKENSCHLAG_CASE,
        initial,
        testUsers.host.id,
        { ...staleRequest, expectedVersion: 1 },
        time(72),
      ),
    );
    expect(accepted.state.version).toBe(2);
    const lockedRequest = catalogRequest(
      accepted.state,
      glockenschlagIds.questions.miriamConcentrate,
      73,
    );
    const locked = mustFailure(
      askCatalogQuestion(
        STILLER_GLOCKENSCHLAG_CASE,
        accepted.state,
        testUsers.host.id,
        lockedRequest,
        time(73),
      ),
    );
    expect(locked.code).toBe('QUESTION_NOT_AVAILABLE');
    expect(accepted.state.receipts).toHaveLength(1);
    expect(accepted.state.events).toHaveLength(2);
  });
});
