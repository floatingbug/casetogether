import {
  CaseIdSchema,
  RoomIdSchema,
  SuspectIdSchema,
  type GameSnapshot,
} from '@casetogether/shared';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../src/api/http';
import {
  RealtimeClientError,
  type RealtimeApplicationEvent,
  type RealtimeConnectionEvent,
} from '../../src/realtime/client';
import { useAuthStore } from '../../src/stores/auth';
import { useGameStore } from '../../src/stores/game';
import { testUser } from '../fixtures';
import {
  activeRoomSnapshot,
  alternateRequestUuid,
  completedGame,
  invitationCode,
  investigatingGame,
  readyRoomSnapshot,
  requestUuid,
  socketSnapshot,
  suspectAnsweredEvent,
  waitingRoomResponse,
} from '../game-fixtures';

const mocks = vi.hoisted(() => ({
  connected: true,
  createRoom: vi.fn(),
  joinRoomRest: vi.fn(),
  getRoom: vi.fn(),
  rotateInvitation: vi.fn(),
  startGameRest: vi.fn(),
  listCases: vi.fn(),
  getSession: vi.fn(),
  submitFinal: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  joinRoomSocket: vi.fn(),
  syncRoom: vi.fn(),
  leaveRoom: vi.fn(),
  sendChat: vi.fn(),
  askCatalog: vi.fn(),
  subscribeConnection: vi.fn(),
  subscribeEvents: vi.fn(),
}));

vi.mock('../../src/api/rooms', () => ({
  roomsApi: {
    createRoom: mocks.createRoom,
    joinRoom: mocks.joinRoomRest,
    getRoom: mocks.getRoom,
    rotateInvitation: mocks.rotateInvitation,
    startGame: mocks.startGameRest,
  },
}));
vi.mock('../../src/api/cases', () => ({ casesApi: { listCases: mocks.listCases } }));
vi.mock('../../src/api/game-sessions', () => ({
  gameSessionsApi: { getSession: mocks.getSession, submitFinalSolution: mocks.submitFinal },
}));
vi.mock('../../src/realtime/client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/realtime/client');
  return {
    ...actual,
    realtimeClient: {
      get connected() {
        return mocks.connected;
      },
      connect: mocks.connect,
      disconnect: mocks.disconnect,
      joinRoom: mocks.joinRoomSocket,
      syncRoom: mocks.syncRoom,
      leaveRoom: mocks.leaveRoom,
      sendChat: mocks.sendChat,
      askCatalog: mocks.askCatalog,
      subscribeConnection: mocks.subscribeConnection,
      subscribeEvents: mocks.subscribeEvents,
    },
  };
});

const connectionListeners: Array<(event: RealtimeConnectionEvent) => void> = [];
const eventListeners: Array<(event: RealtimeApplicationEvent) => void> = [];
const uuidSequence = [
  requestUuid,
  alternateRequestUuid,
  '6b499a92-d3a9-49ed-9393-980b17472ea1',
  'db014a50-daf5-4b59-a944-1001e9699f04',
  'f423f541-ebee-4915-a31c-736d36a2e6e2',
  '870a703c-4837-4232-8941-5de44ed16e37',
];
let uuidIndex = 0;

beforeEach(() => {
  setActivePinia(createPinia());
  useAuthStore().setUser(testUser);
  connectionListeners.length = 0;
  eventListeners.length = 0;
  for (const value of Object.values(mocks)) {
    if (typeof value === 'function') value.mockReset();
  }
  mocks.connected = true;
  mocks.connect.mockResolvedValue(undefined);
  mocks.disconnect.mockImplementation(() => {
    mocks.connected = false;
  });
  mocks.subscribeConnection.mockImplementation(
    (listener: (event: RealtimeConnectionEvent) => void) => {
      connectionListeners.push(listener);
      return () => undefined;
    },
  );
  mocks.subscribeEvents.mockImplementation(
    (listener: (event: RealtimeApplicationEvent) => void) => {
      eventListeners.push(listener);
      return () => undefined;
    },
  );
  mocks.joinRoomRest.mockResolvedValue(readyRoomSnapshot());
  mocks.joinRoomSocket.mockImplementation(({ roomId }: { roomId: string }) =>
    Promise.resolve(
      socketSnapshot(null, {
        ...readyRoomSnapshot(),
        room: { ...readyRoomSnapshot().room, id: RoomIdSchema.parse(roomId) },
      }),
    ),
  );
  mocks.listCases.mockResolvedValue([
    {
      id: 'case_fixture',
      title: 'Das Archiv',
      description: 'Ein fiktiver Katalogfall.',
      estimatedDurationMinutes: 30,
    },
  ]);
  uuidIndex = 0;
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => {
      const value = uuidSequence[uuidIndex] ?? requestUuid;
      uuidIndex += 1;
      return value;
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function joinLobby() {
  const store = useGameStore();
  await expect(store.joinRoom(invitationCode.toLowerCase())).resolves.toBe(true);
  return store;
}

async function startCatalogGame() {
  const store = await joinLobby();
  await store.handleSocketConnected();
  expect(store.connectionStatus).toBe('connected');
  await expect(store.loadCases()).resolves.toBe(true);
  mocks.startGameRest.mockResolvedValue(investigatingGame());
  const started = investigatingGame();
  mocks.syncRoom.mockResolvedValue(socketSnapshot(started, activeRoomSnapshot()));
  await expect(store.startGame(CaseIdSchema.parse('case_fixture'))).resolves.toBe(true);
  expect(store.game).toEqual(started);
  return store;
}

function replay(roomId = 'room_fixture') {
  return {
    outcome: 'replayed',
    roomId,
    invitation: null,
    recovery: 'rotate_with_new_client_request_id_if_needed',
  };
}

describe('room secrets and REST idempotency in the Pinia flow', () => {
  it('shows the initial invitation only in memory and clears it with private room state', async () => {
    const created = waitingRoomResponse();
    mocks.createRoom.mockResolvedValue(created);
    const store = useGameStore();

    await expect(store.createRoom()).resolves.toBe(true);
    expect(store.invitation).toEqual(created.invitation);
    expect(store.room?.room).toEqual(created.room);
    expect(JSON.stringify(store.$state)).toContain(created.invitation.code);

    store.reset();
    expect(store.invitation).toBeNull();
    expect(store.room).toBeNull();
    expect(JSON.stringify(store.$state)).not.toContain(created.invitation.code);
  });

  it('retains create request id after an unknown outcome and exposes code-free lost-secret replay', async () => {
    mocks.createRoom
      .mockRejectedValueOnce(new TypeError('offline fixture'))
      .mockResolvedValueOnce(replay());
    const store = useGameStore();

    await expect(store.createRoom()).resolves.toBe(false);
    await expect(store.createRoom()).resolves.toBe(true);

    expect(mocks.createRoom).toHaveBeenCalledTimes(2);
    expect(mocks.createRoom.mock.calls[0]?.[0]).toEqual(mocks.createRoom.mock.calls[1]?.[0]);
    expect(store.invitation).toBeNull();
    expect(store.lostSecret).toMatchObject({ outcome: 'replayed', invitation: null });
    expect(store.room).toBeNull();
    expect(store.errorMessage).not.toContain(invitationCode);
  });

  it('opens an authorized lost-secret room and rotates only with a fresh request id', async () => {
    mocks.createRoom.mockResolvedValue(replay());
    mocks.getRoom.mockResolvedValue(readyRoomSnapshot());
    const rotatedInvitation = { code: 'NPRS-TUVW-XYZ2', expiresAt: '2026-11-16T11:30:00.000Z' };
    mocks.rotateInvitation.mockResolvedValue({
      outcome: 'rotated',
      room: { ...readyRoomSnapshot().room, version: 2 },
      invitation: rotatedInvitation,
    });
    const store = useGameStore();
    await store.createRoom();
    await expect(store.openRecoveredRoom()).resolves.toBe(true);
    await expect(store.rotateInvitation()).resolves.toBe(true);

    expect(mocks.rotateInvitation).toHaveBeenCalledWith({
      roomId: 'room_fixture',
      expectedVersion: 1,
      clientRequestId: alternateRequestUuid,
    });
    expect(store.invitation).toEqual(rotatedInvitation);
    expect(store.lostSecret).toBeNull();
  });

  it('uses the same lost rotation request once, then a deliberate new UUID for recovery', async () => {
    const store = await joinLobby();
    mocks.rotateInvitation
      .mockRejectedValueOnce(new TypeError('offline fixture'))
      .mockResolvedValueOnce(replay())
      .mockResolvedValueOnce({
        outcome: 'rotated',
        room: { ...readyRoomSnapshot().room, version: 2 },
        invitation: { code: 'NPRS-TUVW-XYZ2', expiresAt: '2026-11-16T11:30:00.000Z' },
      });

    await expect(store.rotateInvitation()).resolves.toBe(false);
    await expect(store.rotateInvitation()).resolves.toBe(true);
    expect(store.invitation).toBeNull();
    expect(store.lostSecret).not.toBeNull();
    expect(mocks.rotateInvitation.mock.calls[0]?.[0]).toEqual(
      mocks.rotateInvitation.mock.calls[1]?.[0],
    );

    await expect(store.rotateInvitation()).resolves.toBe(true);
    const third = mocks.rotateInvitation.mock.calls[2]?.[0];
    expect(third).not.toEqual(mocks.rotateInvitation.mock.calls[1]?.[0]);
    expect(third.clientRequestId).not.toBe(
      mocks.rotateInvitation.mock.calls[1]?.[0].clientRequestId,
    );
    expect(store.invitation?.code).toBe('NPRS-TUVW-XYZ2');
  });

  it('keeps code and UUID unchanged for a join retry whose receipt survives rotation', async () => {
    mocks.joinRoomRest
      .mockRejectedValueOnce(new ApiClientError('NETWORK_ERROR', 'unknown outcome'))
      .mockResolvedValueOnce(readyRoomSnapshot(5));
    const store = useGameStore();

    await expect(store.joinRoom(invitationCode)).resolves.toBe(false);
    await expect(store.joinRoom(invitationCode)).resolves.toBe(true);

    expect(mocks.joinRoomRest).toHaveBeenCalledTimes(2);
    expect(mocks.joinRoomRest.mock.calls[0]?.[0]).toEqual(mocks.joinRoomRest.mock.calls[1]?.[0]);
    expect(mocks.joinRoomRest.mock.calls[0]?.[0].code).toBe(invitationCode);
    expect(store.room?.room.version).toBe(5);
    expect(store.invitation).toBeNull();
  });
});

describe('reconnect, version repair and server-only game mutations', () => {
  it('loads the personal game snapshot when an authorized join receipt points to a started room', async () => {
    mocks.joinRoomRest.mockResolvedValue(activeRoomSnapshot(5));
    const projected = investigatingGame(3);
    mocks.getSession.mockResolvedValue(projected);
    const store = useGameStore();

    await expect(store.joinRoom(invitationCode)).resolves.toBe(true);
    expect(mocks.getSession).toHaveBeenCalledWith('session_fixture');
    expect(store.room?.room.version).toBe(5);
    expect(store.game).toEqual(projected);
  });

  it('repeats an unconfirmed leave directly after connect, without join or sync', async () => {
    const store = await joinLobby();
    mocks.leaveRoom
      .mockRejectedValueOnce(
        new RealtimeClientError('ACK_TIMEOUT', 'unknown', { confirmed: false }),
      )
      .mockResolvedValueOnce({ roomId: 'room_fixture', roomVersion: 2, closed: false });

    await expect(store.leaveRoom()).resolves.toBe(false);
    expect(store.pendingLeave).not.toBeNull();
    const pending = store.pendingLeave;
    await expect(store.handleSocketConnected()).resolves.toBeUndefined();

    expect(mocks.leaveRoom).toHaveBeenCalledTimes(2);
    expect(mocks.leaveRoom.mock.calls[0]?.[0]).toEqual(pending);
    expect(mocks.leaveRoom.mock.calls[1]?.[0]).toEqual(pending);
    expect(mocks.joinRoomSocket).not.toHaveBeenCalled();
    expect(mocks.syncRoom).not.toHaveBeenCalled();
    expect(store.room).toBeNull();
    expect(store.pendingLeave).toBeNull();
  });

  it('runs the complete catalog-only flow and reveals resolution only from the final server snapshot', async () => {
    const store = await startCatalogGame();
    expect(store.cases).toHaveLength(1);
    expect(store.game?.phase).toBe('investigating');
    expect(store.game?.result).toBeNull();

    const event = suspectAnsweredEvent(2);
    mocks.askCatalog.mockResolvedValue({ event });
    const question = store.game?.availableQuestions[0];
    if (question === undefined) throw new Error('Expected catalog fixture');
    await expect(store.askCatalog(question)).resolves.toBe(true);

    expect(store.game?.version).toBe(2);
    expect(store.game?.dialogues).toEqual([event.payload.dialogue]);
    expect(store.game?.publicClues).toEqual(event.payload.newPublicClues);
    expect(store.game?.privateClues).toEqual(event.payload.newPrivateClues);
    expect(mocks.askCatalog.mock.calls[0]?.[0]).toMatchObject({
      mode: 'catalog',
      questionId: question.questionId,
      expectedVersion: 1,
    });
    expect(JSON.stringify(mocks.askCatalog.mock.calls[0]?.[0])).not.toContain('answer');

    const completed = completedGame(3);
    mocks.submitFinal.mockResolvedValue(completed);
    await expect(store.submitFinal(SuspectIdSchema.parse('suspect_ada'))).resolves.toBe(true);
    expect(store.game).toEqual(completed);
    expect(store.game?.result?.resolution).toEqual(completed.result?.resolution);
    expect(mocks.submitFinal.mock.calls[0]?.[0]).toMatchObject({
      expectedVersion: 2,
      suspectId: 'suspect_ada',
    });
  });

  it('keeps pending final state free of optimistic results until the REST promise succeeds', async () => {
    const store = await startCatalogGame();
    let resolveFinal: ((snapshot: GameSnapshot) => void) | undefined;
    mocks.submitFinal.mockReturnValue(
      new Promise<GameSnapshot>((resolve) => {
        resolveFinal = resolve;
      }),
    );

    const submission = store.submitFinal(SuspectIdSchema.parse('suspect_ada'));
    expect(store.pendingFinal).not.toBeNull();
    expect(store.game?.phase).toBe('investigating');
    expect(store.game?.result).toBeNull();
    expect(store.game?.finalSubmission).toBeNull();

    if (resolveFinal === undefined) throw new Error('Final mock was not invoked');
    resolveFinal(completedGame(2));
    await expect(submission).resolves.toBe(true);
    expect(store.game?.phase).toBe('completed');
    expect(store.pendingFinal).toBeNull();
  });

  it('repairs VERSION_CONFLICT by snapshot and gives a deliberate new question a new UUID/version', async () => {
    const store = await startCatalogGame();
    const firstQuestion = store.game?.availableQuestions[0];
    if (firstQuestion === undefined) throw new Error('Question expected');
    mocks.askCatalog.mockRejectedValueOnce(
      new RealtimeClientError('VERSION_CONFLICT', 'conflict', {
        confirmed: true,
        details: { currentVersion: 2 },
      }),
    );
    mocks.syncRoom.mockResolvedValue(socketSnapshot(investigatingGame(2), activeRoomSnapshot()));

    await expect(store.askCatalog(firstQuestion)).resolves.toBe(false);
    expect(store.game?.version).toBe(2);
    expect(store.pendingQuestion).toBeNull();
    expect(mocks.syncRoom).toHaveBeenCalled();

    mocks.askCatalog.mockResolvedValue({ event: suspectAnsweredEvent(3) });
    const retry = store.game?.availableQuestions[0];
    if (retry === undefined) throw new Error('Question expected after sync');
    await expect(store.askCatalog(retry)).resolves.toBe(true);
    const firstRequest = mocks.askCatalog.mock.calls[0]?.[0];
    const secondRequest = mocks.askCatalog.mock.calls[1]?.[0];
    expect(secondRequest.expectedVersion).toBe(2);
    expect(secondRequest.clientRequestId).not.toBe(firstRequest.clientRequestId);
  });

  it('repairs a live event gap through room sync and falls back to REST on an invalid ack', async () => {
    const store = await startCatalogGame();
    mocks.syncRoom.mockResolvedValue(socketSnapshot(investigatingGame(4), activeRoomSnapshot()));
    expect(eventListeners.length).toBeGreaterThan(0);
    for (const listener of eventListeners) {
      listener({ eventName: 'game:event', payload: suspectAnsweredEvent(4) });
    }
    await vi.waitFor(() => expect(store.game?.version).toBe(4));
    expect(store.game?.privateClues).toEqual([]);
    expect(mocks.syncRoom).toHaveBeenCalled();

    const question = store.game?.availableQuestions[0];
    if (question === undefined) throw new Error('Question expected after gap repair');
    mocks.askCatalog.mockRejectedValue(
      new RealtimeClientError('INVALID_RESPONSE', 'invalid ack', { confirmed: false }),
    );
    mocks.syncRoom.mockRejectedValue(
      new RealtimeClientError('INVALID_RESPONSE', 'invalid sync', { confirmed: false }),
    );
    mocks.getRoom.mockResolvedValue(activeRoomSnapshot());
    mocks.getSession.mockResolvedValue(investigatingGame(5));
    await expect(store.askCatalog(question)).resolves.toBe(false);
    expect(mocks.getRoom).toHaveBeenCalledWith('room_fixture');
    expect(mocks.getSession).toHaveBeenCalledWith('session_fixture');
    expect(store.game?.version).toBe(5);
    expect(store.game?.privateClues).toEqual([]);
  });

  it('receives private clues only through server events and clears all projections on reset', async () => {
    const store = await startCatalogGame();
    const event = suspectAnsweredEvent(2);
    mocks.askCatalog.mockResolvedValue({ event });
    const question = store.game?.availableQuestions[0];
    if (question === undefined) throw new Error('Question expected');
    await store.askCatalog(question);

    expect(JSON.stringify(store.game)).toContain('Eigene Beobachtung');
    expect(eventListeners.length).toBeGreaterThan(0);
    store.reset();
    expect(store.game).toBeNull();
    expect(JSON.stringify(store.$state)).not.toContain('Eigene Beobachtung');
    expect(JSON.stringify(store.$state)).not.toContain('different players private data');
  });
});
