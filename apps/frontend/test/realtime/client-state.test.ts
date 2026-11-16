import { RoomIdSchema } from '@casetogether/shared';
import { describe, expect, it } from 'vitest';
import { nextReconnectCommand, RealtimeClientState } from '../../src/realtime/client-state';
import {
  activeRoomSnapshot,
  completedGame,
  hostMember,
  investigatingGame,
  readyRoomSnapshot,
  secondMember,
  secondUser,
  socketSnapshot,
  suspectAnsweredEvent,
} from '../game-fixtures';
import { testUser } from '../fixtures';

function gameState(version = 1) {
  const state = new RealtimeClientState();
  expect(
    state.applyAuthoritativeSnapshot(activeRoomSnapshot(), investigatingGame(version)).applied,
  ).toBe(true);
  return state;
}

describe('recipient-specific realtime state', () => {
  it('applies only v+1 catalog deltas, validates the whole result and deduplicates event/ack', () => {
    const state = gameState();
    const event = suspectAnsweredEvent(2);

    expect(state.applyGameEvent(event)).toMatchObject({ applied: true });
    expect(state.game).toMatchObject({
      version: 2,
      phase: 'investigating',
      publicClues: event.payload.newPublicClues,
      privateClues: event.payload.newPrivateClues,
      dialogues: [event.payload.dialogue],
      availableQuestions: event.payload.availableQuestions,
    });
    expect(state.applyGameEvent(event).reason).toBe('duplicate');
    expect(state.applyGameEvent({ ...event, eventId: 'late_ack_same_version' }).reason).toBe(
      'stale',
    );
    expect(state.game?.version).toBe(2);
    expect(state.game?.privateClues).toEqual(event.payload.newPrivateClues);
  });

  it('does not guess invisible actor-private content during gaps and repairs from a snapshot', () => {
    const actor = gameState();
    const otherMember = gameState();
    const event = suspectAnsweredEvent(2);
    actor.applyGameEvent(event);

    const privateOnlyGap = suspectAnsweredEvent(4);
    expect(otherMember.applyGameEvent(privateOnlyGap)).toMatchObject({
      applied: false,
      syncRequired: true,
    });
    expect(otherMember.game?.privateClues).toEqual([]);
    expect(otherMember.game?.dialogues).toEqual([]);
    expect(JSON.stringify(otherMember.game)).not.toContain('Eigene Beobachtung');

    const repaired = investigatingGame(4);
    expect(otherMember.applySnapshot(socketSnapshot(repaired, activeRoomSnapshot())).applied).toBe(
      true,
    );
    expect(otherMember.game).toEqual(repaired);
    expect(otherMember.game?.privateClues).toEqual([]);
    expect(actor.game?.privateClues).toEqual(event.payload.newPrivateClues);
  });

  it('rejects incomplete or invalid deltas without partially exposing their payload', () => {
    const state = gameState();
    const event = suspectAnsweredEvent(2);
    const invalid = {
      ...event,
      payload: {
        ...event.payload,
        availableQuestions: [
          event.payload.availableQuestions[0],
          event.payload.availableQuestions[0],
        ],
      },
    };

    expect(state.applyGameEvent(invalid)).toMatchObject({ syncRequired: true });
    expect(state.game?.version).toBe(1);
    expect(state.game?.privateClues).toEqual([]);
    expect(state.applyGameEvent({ type: 'game.unknown', version: 2 }).syncRequired).toBe(true);
    expect(state.game?.version).toBe(1);
  });

  it('keeps newer state on stale snapshots and replaces terminal state only by server snapshots', () => {
    const state = gameState();
    state.applyGameEvent(suspectAnsweredEvent(2));
    const before = state.game;

    expect(
      state.applySnapshot(socketSnapshot(investigatingGame(1), activeRoomSnapshot())).reason,
    ).toBe('applied');
    expect(state.game?.version).toBe(2);
    expect(state.game?.privateClues).toEqual(before?.privateClues);

    const completed = completedGame(3);
    const terminal = {
      eventId: 'event_completed',
      sessionId: completed.sessionId,
      version: 3,
      type: 'game.completed',
      occurredAt: '2026-11-16T10:10:00.000Z',
      payload: { snapshot: completed },
    };
    expect(state.applyGameEvent(terminal).applied).toBe(true);
    expect(state.game).toEqual(completed);
    expect(state.game?.result?.resolution.title).toBe('Der verschlossene Seiteneingang');
    expect(state.game?.finishedAt).toBe(completed.finishedAt);
  });

  it('requires snapshot repair for gaps even when a terminal payload is complete', () => {
    const state = gameState();
    const completed = completedGame(5);
    expect(
      state.applyGameEvent({
        eventId: 'event_terminal_gap',
        sessionId: completed.sessionId,
        version: 5,
        type: 'game.completed',
        occurredAt: '2026-11-16T10:10:00.000Z',
        payload: { snapshot: completed },
      }),
    ).toMatchObject({ syncRequired: true });
    expect(state.game?.phase).toBe('investigating');
    expect(state.game?.result).toBeNull();
  });

  it('starts from a full version-1 event and does not roll back with a repeated start', () => {
    const state = new RealtimeClientState();
    expect(
      state.applyRoomSnapshotEvent({
        snapshot: activeRoomSnapshot(),
        emittedAt: '2026-11-16T10:00:01.000Z',
      }).applied,
    ).toBe(true);
    const started = investigatingGame();
    expect(
      state.applyGameEvent({
        eventId: 'event_started',
        sessionId: started.sessionId,
        version: 1,
        type: 'game.started',
        occurredAt: started.startedAt,
        payload: { snapshot: started },
      }).applied,
    ).toBe(true);
    expect(state.game).toEqual(started);
  });
});

describe('independent room, presence and chat chronology', () => {
  it('handles invitation rotation without any invented code and deduplicates its room version', () => {
    const state = new RealtimeClientState();
    state.applyAuthoritativeSnapshot(readyRoomSnapshot(1), null);
    const rotated = {
      eventId: 'room_rotation_2',
      roomId: 'room_fixture',
      version: 2,
      type: 'room.invitation_rotated',
      occurredAt: '2026-11-16T10:02:00.000Z',
      payload: { expiresAt: '2026-11-16T11:02:00.000Z' },
    };

    expect(state.applyRoomEvent(rotated).applied).toBe(true);
    expect(state.room?.room.version).toBe(2);
    expect(JSON.stringify(state.room)).not.toContain('invitation');
    expect(state.applyRoomEvent(rotated).reason).toBe('duplicate');
    expect(
      state.applyRoomEvent({ ...rotated, eventId: 'room_gap_4', version: 4 }).syncRequired,
    ).toBe(true);
    expect(state.room?.room.version).toBe(2);
    expect(
      state.applyRoomEvent({ ...rotated, version: 3, payload: { code: 'ABCD-EFGH-JKLM' } })
        .syncRequired,
    ).toBe(true);
  });

  it('replaces full presence without touching room/game versions and deduplicates chat by id', () => {
    const state = new RealtimeClientState();
    state.applyAuthoritativeSnapshot(readyRoomSnapshot(1), null);
    const roomVersion = state.room?.room.version;
    expect(
      state.applyRoomPresence({
        roomId: 'room_fixture',
        emittedAt: '2026-11-16T10:03:00.000Z',
        members: [
          { userId: testUser.id, status: 'offline', changedAt: '2026-11-16T10:03:00.000Z' },
          { userId: secondUser.id, status: 'online', changedAt: '2026-11-16T10:03:00.000Z' },
        ],
      }).applied,
    ).toBe(true);
    expect(state.room?.room.version).toBe(roomVersion);
    expect(state.room?.presence[0]?.status).toBe('offline');

    const message = {
      id: 'message_2',
      roomId: 'room_fixture',
      sender: secondUser,
      content: 'Zuerst die Katalogfrage.',
      createdAt: '2026-11-16T10:02:30.000Z',
    };
    expect(state.applyChatMessage({ message }).applied).toBe(true);
    expect(state.applyChatMessage({ message }).reason).toBe('duplicate');
    expect(state.room?.recentMessages).toEqual([message]);
    expect(state.room?.room.version).toBe(roomVersion);
  });

  it('updates member lists only through contiguous room events', () => {
    const state = new RealtimeClientState();
    state.applyAuthoritativeSnapshot(activeRoomSnapshot(), investigatingGame());
    const memberRoom = new RealtimeClientState();
    memberRoom.applyAuthoritativeSnapshot(readyRoomSnapshot(1), null);
    expect(
      memberRoom.applyRoomEvent({
        eventId: 'room_left_2',
        roomId: 'room_fixture',
        version: 2,
        type: 'room.member_left',
        occurredAt: '2026-11-16T10:03:00.000Z',
        payload: { userId: secondMember.user.id, status: 'waiting' },
      }).applied,
    ).toBe(true);
    expect(memberRoom.room?.room.members).toEqual([hostMember]);
    expect(memberRoom.room?.room.status).toBe('waiting');
    expect(state.game?.members).toHaveLength(2);
  });
});

describe('reconnect command ordering', () => {
  it('repeats unconfirmed leave before any room join', () => {
    const request = {
      roomId: RoomIdSchema.parse('room_fixture'),
      expectedVersion: 3,
      clientRequestId: '5c6088d1-710f-4d58-a1d4-8d866fa43a6d',
    };
    expect(nextReconnectCommand({ roomId: request.roomId, pendingLeave: request })).toEqual({
      type: 'retry-leave',
      request,
    });
    expect(nextReconnectCommand({ roomId: request.roomId })).toEqual({
      type: 'join',
      request: { roomId: request.roomId },
    });
  });
});
