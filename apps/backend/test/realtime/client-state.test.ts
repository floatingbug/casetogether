import { describe, expect, it } from 'vitest';
import {
  ChatMessageSchema,
  GameEventSchema,
  GameSnapshotSchema,
  PublicUserSchema,
  RoomEventSchema,
  RoomJoinAckDataSchema,
  RoomLeaveRequestSchema,
  RoomMemberSchema,
  RoomPresenceEventSchema,
  RoomSnapshotSchema,
  SuspectAnsweredEventSchema,
  type GameSnapshot,
  type PublicUser,
  type RoomSnapshot,
} from '@casetogether/shared';
import { nextReconnectCommand, RealtimeClientState } from '../../src/realtime/client-state.js';

const NOW = '2026-11-15T12:00:00.000Z';
const LATER = '2026-11-15T12:00:01.000Z';
const host: PublicUser = PublicUserSchema.parse({ id: 'user-host', displayName: 'Host' });
const guest: PublicUser = PublicUserSchema.parse({ id: 'user-guest', displayName: 'Guest' });
const hostMember = RoomMemberSchema.parse({ user: host, role: 'host', joinedAt: NOW });
const guestMember = RoomMemberSchema.parse({ user: guest, role: 'member', joinedAt: NOW });
const firstMessage = ChatMessageSchema.parse({
  id: 'message-1',
  roomId: 'room-1',
  sender: host,
  content: 'first',
  createdAt: NOW,
});
const liveMessage = ChatMessageSchema.parse({
  id: 'message-2',
  roomId: 'room-1',
  sender: guest,
  content: 'live',
  createdAt: LATER,
});

function roomSnapshot(version = 1, multiplayer = false): RoomSnapshot {
  return RoomSnapshotSchema.parse({
    room: {
      id: 'room-1',
      status: multiplayer ? 'ready' : 'waiting',
      version,
      host,
      members: multiplayer ? [hostMember, guestMember] : [hostMember],
      maxPlayers: 4,
      activeSessionId: null,
      createdAt: NOW,
      expiresAt: '2026-11-16T12:00:00.000Z',
    },
    recentMessages: [firstMessage],
    presence: [
      { userId: host.id, status: 'offline', changedAt: NOW },
      ...(multiplayer ? [{ userId: guest.id, status: 'offline' as const, changedAt: NOW }] : []),
    ],
  });
}

function joinAck(room: RoomSnapshot, game: GameSnapshot | null = null): unknown {
  return {
    ok: true,
    data: RoomJoinAckDataSchema.parse({ room, game, serverTime: NOW }),
  };
}

function gameSnapshot(): GameSnapshot {
  return GameSnapshotSchema.parse({
    sessionId: 'session-1',
    roomId: 'room-1',
    caseId: 'case-1',
    caseVersion: '1.0.0',
    phase: 'investigating',
    version: 1,
    members: [hostMember, guestMember],
    suspects: [
      { id: 'suspect-1', displayName: 'One', publicDescription: 'First suspect' },
      { id: 'suspect-2', displayName: 'Two', publicDescription: 'Second suspect' },
      { id: 'suspect-3', displayName: 'Three', publicDescription: 'Third suspect' },
    ],
    availableQuestions: [],
    publicClues: [],
    privateClues: [],
    dialogues: [],
    finalSubmission: null,
    result: null,
    startedAt: NOW,
    finishedAt: null,
  });
}

describe('RealtimeClientState room, chat and presence ordering', () => {
  it('deduplicates live/ack/snapshot messages without rolling newer state back', () => {
    const state = new RealtimeClientState();
    expect(state.applyRoomJoinAck(joinAck(roomSnapshot())).applied).toBe(true);
    expect(state.applyChatMessage({ message: liveMessage })).toMatchObject({
      applied: true,
      reason: 'applied',
    });
    expect(state.applyChatAck({ ok: true, data: { message: liveMessage } })).toMatchObject({
      reason: 'duplicate',
    });

    expect(state.applyRoomJoinAck(joinAck(roomSnapshot())).applied).toBe(true);
    expect(state.room?.recentMessages.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
    ]);
    const joined = RoomEventSchema.parse({
      eventId: 'room-event-2',
      roomId: 'room-1',
      version: 2,
      type: 'room.member_joined',
      occurredAt: LATER,
      payload: { member: guestMember },
    });
    expect(state.applyRoomEvent(joined)).toMatchObject({ applied: true });
    expect(state.applyRoomEvent(joined)).toMatchObject({ reason: 'duplicate' });
    expect(
      state.applyRoomEvent({ ...joined, eventId: 'room-event-gap', version: 4 }),
    ).toMatchObject({
      syncRequired: true,
    });
    expect(state.room?.room.version).toBe(2);

    expect(state.applyRoomJoinAck(joinAck(roomSnapshot()))).toMatchObject({ reason: 'stale' });
    expect(state.room?.room.version).toBe(2);
    expect(state.room?.recentMessages).toHaveLength(2);
    expect(
      state.applyRoomSnapshotEvent({ snapshot: { invalid: true }, emittedAt: LATER }),
    ).toMatchObject({
      syncRequired: true,
    });
    expect(state.room?.room.version).toBe(2);
  });

  it('replaces only a complete membership-presence projection without changing the room version', () => {
    const state = new RealtimeClientState();
    state.applyRoomJoinAck(joinAck(roomSnapshot(2, true)));
    const presence = RoomPresenceEventSchema.parse({
      roomId: 'room-1',
      members: [
        { userId: host.id, status: 'online', changedAt: LATER },
        { userId: guest.id, status: 'offline', changedAt: NOW },
      ],
      emittedAt: LATER,
    });
    expect(state.applyRoomPresence(presence)).toMatchObject({ applied: true });
    expect(state.room?.room.version).toBe(2);
    expect(state.room?.presence).toEqual(presence.members);
    expect(state.applyRoomPresence({ ...presence, members: [presence.members[0]] })).toMatchObject({
      syncRequired: true,
    });
    expect(state.room?.presence).toEqual(presence.members);
  });

  it('syncs on leave version conflicts and keeps newer state safe from stale receipts', () => {
    const state = new RealtimeClientState();
    state.applyRoomJoinAck(joinAck(roomSnapshot(2, true)));
    expect(
      state.applyRoomLeaveAck({
        ok: false,
        error: {
          code: 'VERSION_CONFLICT',
          message: 'Room version changed',
          requestId: 'request-version-conflict',
          details: { currentVersion: 3 },
        },
      }),
    ).toMatchObject({ syncRequired: true });
    expect(state.room?.room.version).toBe(2);
    state.applyRoomJoinAck(joinAck(roomSnapshot(3, true)));
    expect(
      state.applyRoomLeaveAck({
        ok: true,
        data: { roomId: 'room-1', roomVersion: 2, closed: false },
      }),
    ).toMatchObject({ reason: 'stale' });
    expect(state.room?.room.version).toBe(3);
    expect(
      state.applyRoomLeaveAck({
        ok: true,
        data: { roomId: 'room-1', roomVersion: 3, closed: true },
      }),
    ).toMatchObject({ applied: true });
    expect(state.room?.room.status).toBe('closed');
    expect(state.room).not.toBeNull();

    const memberState = new RealtimeClientState();
    memberState.applyRoomJoinAck(joinAck(roomSnapshot(2, true)));
    expect(
      memberState.applyRoomLeaveAck({
        ok: true,
        data: { roomId: 'room-1', roomVersion: 3, closed: false },
      }),
    ).toMatchObject({ reason: 'cleared' });
    expect(memberState.room).toBeNull();
  });

  it('honors closed versus not-found/unauthenticated ack cleanup semantics', () => {
    const state = new RealtimeClientState();
    state.applyRoomJoinAck(joinAck(roomSnapshot()));
    const closed = state.applyRoomJoinAck({
      ok: false,
      error: { code: 'ROOM_CLOSED', message: 'Room closed', requestId: 'request-closed' },
    });
    expect(closed).toMatchObject({ reason: 'rejected' });
    expect(state.room).not.toBeNull();
    expect(
      state.applyRoomJoinAck({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'request-not-found' },
      }),
    ).toMatchObject({ reason: 'cleared' });
    expect(state.room).toBeNull();
    expect(state.game).toBeNull();
  });
});

describe('RealtimeClientState game snapshot safety without game commands', () => {
  it('validates snapshots/deltas, deduplicates ack/live events and syncs on gaps or schema errors', () => {
    const state = new RealtimeClientState();
    const lobby = roomSnapshot(2, true);
    state.applyRoomJoinAck(joinAck(lobby));
    const startedRoom = RoomEventSchema.parse({
      eventId: 'room-event-started',
      roomId: 'room-1',
      version: 3,
      type: 'room.started',
      occurredAt: LATER,
      payload: { sessionId: 'session-1' },
    });
    expect(state.applyRoomEvent(startedRoom)).toMatchObject({ applied: true });
    const game = gameSnapshot();
    const started = GameEventSchema.parse({
      eventId: 'game-event-1',
      sessionId: 'session-1',
      version: 1,
      type: 'game.started',
      occurredAt: LATER,
      payload: { snapshot: game },
    });
    expect(state.applyGameEvent(started)).toMatchObject({ applied: true });
    expect(state.applyGameEvent(started)).toMatchObject({ reason: 'duplicate' });

    const answered = SuspectAnsweredEventSchema.parse({
      eventId: 'game-event-2',
      sessionId: 'session-1',
      version: 2,
      type: 'suspect.answered',
      occurredAt: LATER,
      payload: {
        dialogue: null,
        newPublicClues: [],
        newPrivateClues: [],
        availableQuestions: [],
        phase: 'investigating',
      },
    });
    expect(state.applyGameEvent(answered)).toMatchObject({ applied: true });
    expect(state.game?.version).toBe(2);
    expect(state.applyGameEvent(answered)).toMatchObject({ reason: 'duplicate' });
    expect(state.applyGameSnapshotEvent({ snapshot: game, emittedAt: LATER })).toMatchObject({
      reason: 'stale',
    });
    expect(state.game?.version).toBe(2);
    const staleOtherSession = GameSnapshotSchema.parse({ ...game, sessionId: 'session-old' });
    expect(
      state.applyGameSnapshotEvent({ snapshot: staleOtherSession, emittedAt: LATER }),
    ).toMatchObject({ syncRequired: true });
    expect(state.game?.sessionId).toBe('session-1');
    expect(state.game?.version).toBe(2);
    expect(
      state.applyGameEvent({ ...answered, eventId: 'game-event-gap', version: 4 }),
    ).toMatchObject({
      syncRequired: true,
    });
    expect(state.game?.version).toBe(2);
    expect(
      state.applyGameEvent({
        ...answered,
        eventId: 'game-event-invalid',
        version: 3,
        payload: { ...answered.payload, newPrivateClues: undefined },
      }),
    ).toMatchObject({ syncRequired: true });
    expect(state.game?.version).toBe(2);
  });
});

describe('unconfirmed leave reconnect order', () => {
  it('retries the byte-equivalent command with the same key before any room join', () => {
    const pendingLeave = RoomLeaveRequestSchema.parse({
      roomId: 'room-1',
      clientRequestId: '123e4567-e89b-42d3-a456-426614174000',
      expectedVersion: 2,
    });
    expect(nextReconnectCommand({ roomId: pendingLeave.roomId, pendingLeave })).toEqual({
      type: 'retry-leave',
      request: pendingLeave,
    });
    expect(nextReconnectCommand({ roomId: pendingLeave.roomId, pendingLeave }).type).not.toBe(
      'join',
    );
    expect(nextReconnectCommand({ roomId: pendingLeave.roomId })).toEqual({
      type: 'join',
      request: { roomId: 'room-1' },
    });
  });
});
