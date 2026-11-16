import { CaseIdSchema, SuspectIdSchema } from '@casetogether/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCasesApi } from '../../src/api/cases';
import { createGameSessionsApi } from '../../src/api/game-sessions';
import { createRoomsApi } from '../../src/api/rooms';
import {
  completedGame,
  invitationCode,
  investigatingGame,
  readyRoomSnapshot,
  requestUuid,
  waitingRoomResponse,
} from '../game-fixtures';
import { jsonResponse } from '../fixtures';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
});

function lastRequest(): { path: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) throw new Error('Expected fetch call');
  return { path: String(call[0]), init: call[1] ?? {} };
}

describe('room, case and final REST contracts', () => {
  it('creates with one clientRequestId and accepts both initial secret and code-free replay', async () => {
    const created = waitingRoomResponse();
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: created }, 201)).mockResolvedValueOnce(
      jsonResponse({
        data: {
          outcome: 'replayed',
          roomId: created.room.id,
          invitation: null,
          recovery: 'rotate_with_new_client_request_id_if_needed',
        },
      }),
    );
    const api = createRoomsApi({ fetcher: fetchMock });
    const request = { clientRequestId: requestUuid };

    await expect(api.createRoom(request)).resolves.toEqual(created);
    await expect(api.createRoom(request)).resolves.toMatchObject({
      outcome: 'replayed',
      invitation: null,
    });

    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toEqual(request);
      expect(call[1]).toMatchObject({ method: 'POST', credentials: 'include' });
      expect(new Headers(call[1]?.headers).get('content-type')).toBe('application/json');
      expect(String(call[0])).not.toContain(invitationCode);
    }
  });

  it('keeps the exact code-bound join retry semantics after invitation rotation', async () => {
    const room = readyRoomSnapshot(4);
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ data: room })));
    const api = createRoomsApi({ fetcher: fetchMock });
    const request = { clientRequestId: requestUuid, code: invitationCode };

    await api.joinRoom(request);
    await api.joinRoom(request);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toEqual(request);
      expect(String(call[0])).toBe('/api/v1/rooms/join');
      expect(String(call[0])).not.toContain(invitationCode);
    }
  });

  it('rotates only in the JSON body with expectedVersion and a new request identity', async () => {
    const created = waitingRoomResponse();
    const rotated = {
      outcome: 'rotated',
      room: { ...created.room, version: 2 },
      invitation: { code: 'NPRS-TUVW-XYZ2', expiresAt: '2026-11-16T11:30:00.000Z' },
    };
    fetchMock.mockResolvedValue(jsonResponse({ data: rotated }));
    const api = createRoomsApi({ fetcher: fetchMock });

    await expect(
      api.rotateInvitation({
        roomId: created.room.id,
        clientRequestId: requestUuid,
        expectedVersion: 1,
      }),
    ).resolves.toEqual(rotated);

    const { path, init } = lastRequest();
    expect(path).toBe(`/api/v1/rooms/${created.room.id}/invitation/rotate`);
    expect(JSON.parse(String(init.body))).toEqual({
      clientRequestId: requestUuid,
      expectedVersion: 1,
    });
    expect(path).not.toMatch(/code|token|clientRequestId/);
  });

  it('loads safe case summaries and rejects attempts to expose answer fields', async () => {
    const summaries = [
      {
        id: 'case_fixture',
        title: 'Das Archiv',
        description: 'Ein fiktiver Fall.',
        estimatedDurationMinutes: 30,
      },
    ];
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { items: summaries } }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { items: [{ ...summaries[0], truth: 'secret' }] } }),
      );
    const api = createCasesApi({ fetcher: fetchMock });

    await expect(api.listCases()).resolves.toEqual(summaries);
    await expect(api.listCases()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('starts with expected room version and loads authoritative session snapshots', async () => {
    const game = completedGame();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: investigatingGame() }))
      .mockResolvedValueOnce(jsonResponse({ data: game }))
      .mockResolvedValueOnce(jsonResponse({ data: game }));
    const rooms = createRoomsApi({ fetcher: fetchMock });
    const sessions = createGameSessionsApi({ fetcher: fetchMock });

    await rooms.startGame({
      roomId: 'room_fixture',
      caseId: CaseIdSchema.parse('case_fixture'),
      clientRequestId: requestUuid,
      expectedVersion: 1,
    });
    await expect(sessions.getSession(game.sessionId)).resolves.toEqual(game);
    await expect(
      sessions.submitFinalSolution({
        sessionId: game.sessionId,
        suspectId: SuspectIdSchema.parse('suspect_ada'),
        expectedVersion: 2,
        clientRequestId: requestUuid,
      }),
    ).resolves.toEqual(game);

    const final = lastRequest();
    expect(final.path).toBe(`/api/v1/sessions/${game.sessionId}/final-submission`);
    expect(JSON.parse(String(final.init.body))).toEqual({
      suspectId: 'suspect_ada',
      expectedVersion: 2,
      clientRequestId: requestUuid,
    });
    expect(JSON.parse(String(final.init.body))).not.toHaveProperty('result');
    expect(JSON.parse(String(final.init.body))).not.toHaveProperty('verdict');
  });
});
