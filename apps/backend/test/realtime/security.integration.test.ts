import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  ChatSendAckSchema,
  CreateRoomResponseEnvelopeSchema,
  RoomJoinAckSchema,
  RoomLeaveAckSchema,
  SocketAckFailureSchema,
} from '@casetogether/shared';
import { startMongoTestDatabase, type MongoTestDatabase } from '../support/mongo-test-database.js';
import { postAs, requestId, type ActorSession } from '../support/rooms-test-app.js';
import { emitAck, RealtimeTestWorld } from './support.js';

let mongo: MongoTestDatabase;
let world: RealtimeTestWorld | undefined;

beforeAll(async () => {
  mongo = await startMongoTestDatabase();
});
afterAll(async () => {
  await mongo.close();
});
beforeEach(async () => {
  await mongo.reset();
  await Promise.all([
    mongo.database.collection('rooms').deleteMany({}),
    mongo.database.collection('messages').deleteMany({}),
  ]);
  world = await RealtimeTestWorld.start({ database: mongo.database });
});
afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function createRoom(host: ActorSession): Promise<string> {
  const response = CreateRoomResponseEnvelopeSchema.parse(
    (
      await postAs(world!.app, '/api/v1/rooms', host.cookie)
        .send({ clientRequestId: requestId() })
        .expect(201)
    ).body,
  );
  if (response.data.outcome !== 'created') throw new Error('Expected a created room');
  return response.data.room.id;
}

describe('strict Socket.IO boundaries', () => {
  it('rejects authoritative fields, invalid UUIDs, oversized payloads and unassigned game commands without state changes', async () => {
    const host = await world!.register('socket-validation@example.test', 'Host');
    const roomId = await createRoom(host);
    const client = await world!.connect({ cookie: host.cookie });
    const joined = RoomJoinAckSchema.parse(await emitAck(client, 'room:join', { roomId }));
    expect(joined.ok).toBe(true);

    const spoofed = ChatSendAckSchema.parse(
      await emitAck(client, 'chat:send', {
        roomId,
        clientRequestId: requestId(),
        content: 'not authorized',
        senderUserId: host.user.id,
      }),
    );
    expect(spoofed).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    const invalidUuid = ChatSendAckSchema.parse(
      await emitAck(client, 'chat:send', {
        roomId,
        clientRequestId: 'not-a-uuid',
        content: 'invalid',
      }),
    );
    expect(invalidUuid).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(invalidUuid.ok).toBe(false);
    if (!invalidUuid.ok) expect(invalidUuid.clientRequestId).toBeUndefined();

    const tooLarge = ChatSendAckSchema.parse(
      await emitAck(client, 'chat:send', {
        roomId,
        clientRequestId: requestId(),
        content: 'x'.repeat(17 * 1024),
      }),
    );
    expect(tooLarge).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
    for (const event of ['game:action', 'suspect:question']) {
      const rejected = SocketAckFailureSchema.parse(
        await emitAck(client, event, {
          roomId,
          sessionId: 'invented-session',
          clientRequestId: requestId(),
          expectedVersion: 1,
        }),
      );
      expect(rejected.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await mongo.database.collection('messages').countDocuments()).toBe(0);
    expect(
      await mongo.database.collection('rooms').findOne({ _id: new ObjectId(roomId) }),
    ).toMatchObject({
      version: 1,
      status: 'waiting',
    });
    expect(await mongo.database.listCollections({ name: 'gameSessions' }).toArray()).toHaveLength(
      0,
    );
  });

  it('drops invalid invitation event output instead of leaking an injected code field', async () => {
    const host = await world!.register('socket-output-validation@example.test', 'Host');
    const roomId = await createRoom(host);
    const client = await world!.connect({ cookie: host.cookie });
    await emitAck(client, 'room:join', { roomId });
    let received = false;
    client.on('room:invitation-rotated', () => {
      received = true;
    });

    await expect(
      world!.gateway.publishRoomPublication({
        recipientUserIds: [host.user.id],
        event: {
          eventId: 'invalid-output-event',
          roomId,
          version: 2,
          type: 'room.invitation_rotated',
          occurredAt: new Date().toISOString(),
          payload: {
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            code: 'ABCD-EFGH-JKLM',
          },
        },
      }),
    ).rejects.toThrow();
    expect(received).toBe(false);
  });

  it('returns the current version on stale leave and preserves the complete snapshot for synchronization', async () => {
    const host = await world!.register('socket-conflict-host@example.test', 'Host');
    const guest = await world!.register('socket-conflict-guest@example.test', 'Guest');
    const roomId = await createRoom(host);
    const strangerResult = RoomJoinAckSchema.parse(
      await emitAck(await world!.connect({ cookie: guest.cookie }), 'room:join', { roomId }),
    );
    expect(strangerResult).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    const hostSocket = await world!.connect({ cookie: host.cookie });
    await emitAck(hostSocket, 'room:join', { roomId });
    const leave = RoomLeaveAckSchema.parse(
      await emitAck(hostSocket, 'room:leave', {
        roomId,
        clientRequestId: requestId(),
        expectedVersion: 99,
      }),
    );
    expect(leave).toMatchObject({
      ok: false,
      error: { code: 'VERSION_CONFLICT', details: { currentVersion: 1 } },
    });
    const sync = RoomJoinAckSchema.parse(await emitAck(hostSocket, 'room:sync', { roomId }));
    if (!sync.ok) throw new Error(sync.error.code);
    expect(sync.data.room.room.version).toBe(1);
    expect(sync.data.room.presence).toHaveLength(1);
    expect(sync.data.game).toBeNull();
    expect(
      await mongo.database.collection('rooms').findOne({ _id: new ObjectId(roomId) }),
    ).toMatchObject({
      version: 1,
      status: 'waiting',
    });
  });
});
