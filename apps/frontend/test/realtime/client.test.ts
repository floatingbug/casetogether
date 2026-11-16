import {
  CatalogQuestionRequestSchema,
  ChatSendRequestSchema,
  ClientRequestIdSchema,
  RoomIdSchema,
  RoomJoinRequestSchema,
} from '@casetogether/shared';
import { describe, expect, it } from 'vitest';
import {
  createRealtimeClient,
  RealtimeClientError,
  type RealtimeConnectionEvent,
} from '../../src/realtime/client';
import type { SocketTransport, SocketTransportListeners } from '../../src/realtime/transport';
import {
  readyRoomSnapshot,
  requestUuid,
  socketSnapshot,
  suspectAnsweredEvent,
} from '../game-fixtures';
import { secondUser } from '../game-fixtures';

class FakeTransport implements SocketTransport {
  connected = false;
  readonly calls: Array<{ eventName: string; payload: unknown; timeoutMs: number }> = [];
  private readonly acknowledgements: unknown[] = [];
  private readonly failures: unknown[] = [];

  constructor(private readonly listeners: SocketTransportListeners) {}

  connect(): void {
    this.connected = true;
    this.listeners.connected();
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.listeners.disconnected();
  }

  request(eventName: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    this.calls.push({ eventName, payload, timeoutMs });
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(this.acknowledgements.shift());
  }

  queueAck(value: unknown): void {
    this.acknowledgements.push(value);
  }

  queueFailure(value: unknown): void {
    this.failures.push(value);
  }

  failHandshake(value: unknown): void {
    this.connected = false;
    this.listeners.connectionFailed(value);
  }

  emit(eventName: string, payload: unknown): void {
    this.listeners.applicationEvent(eventName, payload);
  }

  emitUnknown(): void {
    this.listeners.unknownEvent();
  }
}

function fixture() {
  let transport: FakeTransport | undefined;
  const client = createRealtimeClient({
    ackTimeoutMs: 321,
    transportFactory: (listeners) => {
      transport = new FakeTransport(listeners);
      return transport;
    },
  });
  if (transport === undefined) throw new Error('Transport fixture missing');
  return { client, transport };
}

function handshakeError(code: 'UNAUTHENTICATED' | 'CSRF_REJECTED' | 'INTERNAL_ERROR') {
  return {
    error: { code, message: 'Handshake rejected', requestId: 'handshake_request' },
  };
}

describe('typed Socket.IO client and mandatory acknowledgements', () => {
  it('connects and validates room join snapshot data', async () => {
    const { client, transport } = fixture();
    const statuses: RealtimeConnectionEvent['type'][] = [];
    client.subscribeConnection((event) => statuses.push(event.type));
    transport.queueAck({ ok: true, data: socketSnapshot(null, readyRoomSnapshot()) });

    await client.connect();
    const snapshot = await client.joinRoom(
      RoomJoinRequestSchema.parse({ roomId: RoomIdSchema.parse('room_fixture') }),
    );

    expect(snapshot.room).toEqual(readyRoomSnapshot());
    expect(transport.calls[0]).toMatchObject({
      eventName: 'room:join',
      payload: { roomId: RoomIdSchema.parse('room_fixture') },
      timeoutMs: 321,
    });
    expect(statuses).toContain('connected');
  });

  it('validates and normalizes chat sends, including exact retry identity', async () => {
    const { client, transport } = fixture();
    const message = {
      id: 'message_ack',
      roomId: RoomIdSchema.parse('room_fixture'),
      sender: secondUser,
      content: 'Hallo Team',
      createdAt: '2026-11-16T10:11:00.000Z',
    };
    transport.queueAck({ ok: true, data: { message } });
    transport.queueAck({ ok: true, data: { message } });
    const request = ChatSendRequestSchema.parse({
      roomId: RoomIdSchema.parse('room_fixture'),
      clientRequestId: requestUuid,
      content: '  Hallo Team  ',
    });

    await client.sendChat(request);
    await client.sendChat(request);

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.payload).toEqual({ ...request, content: 'Hallo Team' });
    expect(transport.calls[1]?.payload).toEqual(transport.calls[0]?.payload);
  });

  it('uses the same catalog command contract and validates the event inside its ack', async () => {
    const { client, transport } = fixture();
    const event = suspectAnsweredEvent();
    transport.queueAck({ ok: true, data: { event } });
    const request = CatalogQuestionRequestSchema.parse({
      mode: 'catalog',
      sessionId: 'session_fixture',
      clientRequestId: requestUuid,
      expectedVersion: 1,
      suspectId: 'suspect_ada',
      questionId: 'question_alibi',
    });

    await expect(client.askCatalog(request)).resolves.toEqual({ event });
    expect(transport.calls[0]).toMatchObject({ eventName: 'suspect:question', payload: request });
    expect(JSON.stringify(transport.calls[0]?.payload)).not.toContain('answerText');
  });

  it('rejects malformed acknowledgements as an unconfirmed outcome', async () => {
    const { client, transport } = fixture();
    transport.queueAck({ ok: true, data: { unexpected: true } });

    await expect(
      client.leaveRoom({
        roomId: RoomIdSchema.parse('room_fixture'),
        clientRequestId: requestUuid,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', options: { confirmed: false } });
  });

  it('classifies acknowledgement timeouts as unconfirmed', async () => {
    const { client, transport } = fixture();
    transport.queueFailure(new Error('transport implementation detail'));

    await expect(
      client.leaveRoom({
        roomId: RoomIdSchema.parse('room_fixture'),
        clientRequestId: requestUuid,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'ACK_TIMEOUT', options: { confirmed: false } });
  });

  it('branches on validated ApiError.code and preserves VERSION_CONFLICT details', async () => {
    const { client, transport } = fixture();
    transport.queueAck({
      ok: false,
      error: {
        code: 'VERSION_CONFLICT',
        message: 'not used for control flow',
        requestId: 'request_socket',
        details: { currentVersion: 9 },
      },
      clientRequestId: requestUuid,
    });

    const promise = client.leaveRoom({
      roomId: RoomIdSchema.parse('room_fixture'),
      clientRequestId: ClientRequestIdSchema.parse(requestUuid),
      expectedVersion: 1,
    });
    await expect(promise).rejects.toBeInstanceOf(RealtimeClientError);
    await expect(promise).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      options: {
        confirmed: true,
        clientRequestId: requestUuid,
        details: { currentVersion: 9 },
      },
    });
  });

  it.each([
    ['UNAUTHENTICATED', 401],
    ['CSRF_REJECTED', 403],
    ['INTERNAL_ERROR', 500],
  ] as const)(
    'normalizes direct handshake errors and initial long-poll HTTP %s',
    async (code, status) => {
      void status;
      const direct = fixture();
      const directError = new Error('Handshake rejected');
      Reflect.set(directError, 'data', handshakeError(code));
      const directStatus = new Promise<RealtimeConnectionEvent>((resolve) => {
        direct.client.subscribeConnection((event) => {
          if (event.type === 'connection_failed') resolve(event);
        });
      });
      direct.transport.failHandshake(directError);
      await expect(directStatus).resolves.toMatchObject({
        type: 'connection_failed',
        error: { code },
      });

      const polling = fixture();
      const pollingError = new Error('Unexpected transport text');
      Reflect.set(pollingError, 'context', {
        responseText: JSON.stringify(handshakeError(code)),
      });
      const pollingStatus = new Promise<RealtimeConnectionEvent>((resolve) => {
        polling.client.subscribeConnection((event) => {
          if (event.type === 'connection_failed') resolve(event);
        });
      });
      polling.transport.failHandshake(pollingError);
      await expect(pollingStatus).resolves.toMatchObject({
        type: 'connection_failed',
        error: { code },
      });
    },
  );

  it('never infers a handshake category from free message text', async () => {
    const { client, transport } = fixture();
    const status = new Promise<RealtimeConnectionEvent>((resolve) => {
      client.subscribeConnection((event) => {
        if (event.type === 'connection_failed') resolve(event);
      });
    });
    transport.failHandshake(new Error('401 UNAUTHENTICATED at some internal address'));
    await expect(status).resolves.toMatchObject({
      type: 'connection_failed',
      error: { code: 'NETWORK_ERROR' },
    });
  });

  it('rejects unknown incoming application events without forwarding payloads', () => {
    const { client, transport } = fixture();
    const received: unknown[] = [];
    client.subscribeEvents((event) => received.push(event));

    transport.emitUnknown();
    transport.emit('game:event', suspectAnsweredEvent());

    expect(received[0]).toEqual({ eventName: '', payload: undefined });
    expect(received[1]).toMatchObject({ eventName: 'game:event' });
  });
});
