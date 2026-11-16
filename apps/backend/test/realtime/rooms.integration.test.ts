import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  ChatSendAckSchema,
  ChatSendRequestSchema,
  CreateRoomResponseEnvelopeSchema,
  RoomEventSchema,
  RoomJoinAckSchema,
  RoomLeaveAckSchema,
  RoomPresenceEventSchema,
  RotateInvitationResponseEnvelopeSchema,
  type PublicUser,
  type RoomId,
} from '@casetogether/shared';
import {
  ChatMessageDocumentSchema,
  DuplicateChatMessageError,
  MongoChatRepository,
} from '../../src/realtime/chat-persistence.js';
import { unsafePost } from '../support/auth-test-app.js';
import { startMongoTestDatabase, type MongoTestDatabase } from '../support/mongo-test-database.js';
import { postAs, requestId, type ActorSession } from '../support/rooms-test-app.js';
import {
  emitAck,
  nextEvent,
  RealtimeTestWorld,
  recordEvents,
  expectConnectError,
} from './support.js';

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

async function createLobby(
  host: ActorSession,
  guest: ActorSession,
): Promise<{
  roomId: RoomId;
  invitationCode: string;
}> {
  if (world === undefined) throw new Error('Test world is not running');
  const created = CreateRoomResponseEnvelopeSchema.parse(
    (
      await postAs(world.app, '/api/v1/rooms', host.cookie)
        .send({ clientRequestId: requestId() })
        .expect(201)
    ).body,
  );
  if (created.data.outcome !== 'created') throw new Error('Expected a created room');
  const roomId = created.data.room.id;
  await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
    .send({ clientRequestId: requestId(), code: created.data.invitation.code })
    .expect(200);
  return { roomId, invitationCode: created.data.invitation.code };
}

async function join(
  clientParameters: {
    cookie: string;
    transport?: 'websocket' | 'polling';
  },
  roomId: RoomId,
) {
  if (world === undefined) throw new Error('Test world is not running');
  const client = await world.connect(clientParameters);
  const ack = RoomJoinAckSchema.parse(await emitAck(client, 'room:join', { roomId }));
  return { client, ack };
}

function publicUser(actor: ActorSession): PublicUser {
  return actor.user;
}

describe('authorized room snapshots and volatile presence', () => {
  it('synchronizes two transports, rejects strangers/code-joins and preserves membership across reconnects', async () => {
    const host = await world!.register('room-host@example.test', 'Host');
    const guest = await world!.register('room-guest@example.test', 'Guest');
    const stranger = await world!.register('room-stranger@example.test', 'Stranger');
    const { roomId, invitationCode } = await createLobby(host, guest);
    const staleVersion = await mongo.database
      .collection('rooms')
      .findOne({ _id: new ObjectId(roomId) });
    expect(staleVersion?.['version']).toBe(2);

    const hostSocket = (await join({ cookie: host.cookie }, roomId)).client;
    const hostPresence = recordEvents(hostSocket, 'room:presence');
    const guestPromise = world!.connect({ cookie: guest.cookie, transport: 'polling' });
    const guestSocket = await guestPromise;
    const hostPresenceEvent = nextEvent(hostSocket, 'room:presence');
    const guestAck = RoomJoinAckSchema.parse(await emitAck(guestSocket, 'room:join', { roomId }));
    if (!guestAck.ok) throw new Error(guestAck.error.code);
    expect(guestAck.data.game).toBeNull();
    expect(guestAck.data.room.room).toMatchObject({
      id: roomId,
      version: 2,
      status: 'ready',
      activeSessionId: null,
      members: [
        { user: publicUser(host), role: 'host' },
        { user: publicUser(guest), role: 'member' },
      ],
    });
    expect(guestAck.data.room.presence).toEqual([
      { userId: host.user.id, status: 'online', changedAt: expect.any(String) },
      { userId: guest.user.id, status: 'online', changedAt: expect.any(String) },
    ]);
    expect(RoomPresenceEventSchema.parse(await hostPresenceEvent).members).toHaveLength(2);

    const strangerSocket = await world!.connect({ cookie: stranger.cookie });
    const strangerJoin = RoomJoinAckSchema.parse(
      await emitAck(strangerSocket, 'room:join', { roomId }),
    );
    expect(strangerJoin).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const codeJoin = RoomJoinAckSchema.parse(
      await emitAck(hostSocket, 'room:join', { roomId, code: invitationCode }),
    );
    expect(codeJoin).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(
      await mongo.database.collection('rooms').findOne({ _id: new ObjectId(roomId) }),
    ).toMatchObject({
      version: 2,
      members: [{}, {}],
    });

    const offlineEvent = nextEvent(hostSocket, 'room:presence');
    guestSocket.close();
    const offline = RoomPresenceEventSchema.parse(await offlineEvent);
    expect(offline.members).toEqual([
      { userId: host.user.id, status: 'online', changedAt: expect.any(String) },
      { userId: guest.user.id, status: 'offline', changedAt: expect.any(String) },
    ]);
    expect(
      await mongo.database.collection('rooms').findOne({ _id: new ObjectId(roomId) }),
    ).toMatchObject({
      version: 2,
      members: [{}, {}],
    });
    expect(
      await mongo.database
        .collection('authSessions')
        .findOne({ userId: new ObjectId(guest.user.id) }),
    ).toMatchObject({
      revokedAt: null,
    });

    const reconnected = await join({ cookie: guest.cookie, transport: 'polling' }, roomId);
    if (!reconnected.ack.ok) throw new Error(reconnected.ack.error.code);
    expect(reconnected.ack.data.room.room.version).toBe(2);
    expect(reconnected.ack.data.room.presence).toEqual([
      { userId: host.user.id, status: 'online', changedAt: expect.any(String) },
      { userId: guest.user.id, status: 'online', changedAt: expect.any(String) },
    ]);
    expect(hostPresence.length).toBeGreaterThan(0);
  });

  it('persists chat before one logical broadcast and deduplicates live, replay and snapshot messages', async () => {
    const host = await world!.register('chat-host@example.test', 'Host');
    const guest = await world!.register('chat-guest@example.test', 'Guest');
    const stranger = await world!.register('chat-stranger@example.test', 'Stranger');
    const { roomId } = await createLobby(host, guest);
    const hostOne = (await join({ cookie: host.cookie }, roomId)).client;
    const hostTwo = (await join({ cookie: host.cookie, transport: 'polling' }, roomId)).client;
    const guestSocket = (await join({ cookie: guest.cookie }, roomId)).client;
    const hostOneMessages = recordEvents(hostOne, 'chat:message');
    const hostTwoMessages = recordEvents(hostTwo, 'chat:message');
    const guestMessages = recordEvents(guestSocket, 'chat:message');
    const clientRequestId = requestId();
    const request = { roomId, clientRequestId, content: '  Cafe\u0301  ' };
    const delivered = nextEvent(guestSocket, 'chat:message');

    const [first, replay] = await Promise.all([
      emitAck(hostOne, 'chat:send', request),
      emitAck(hostTwo, 'chat:send', request),
    ]);
    const firstAck = ChatSendAckSchema.parse(first);
    const replayAck = ChatSendAckSchema.parse(replay);
    if (!firstAck.ok || !replayAck.ok) throw new Error('Identical chat requests must succeed');
    expect(firstAck.data.message.id).toBe(replayAck.data.message.id);
    expect(firstAck.data.message.content).toBe('Café');
    expect(await delivered).toEqual({ message: firstAck.data.message });
    expect(
      await mongo.database.collection('messages').findOne({ roomId: new ObjectId(roomId) }),
    ).toMatchObject({
      clientRequestId,
      content: 'Café',
    });
    expect(
      [hostOneMessages, hostTwoMessages, guestMessages].map((events) => events.length),
    ).toEqual([1, 1, 1]);

    const reused = ChatSendAckSchema.parse(
      await emitAck(hostOne, 'chat:send', { ...request, content: 'different' }),
    );
    expect(reused).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    const outsiderSocket = await world!.connect({ cookie: stranger.cookie });
    const outsiderReplay = ChatSendAckSchema.parse(
      await emitAck(outsiderSocket, 'chat:send', request),
    );
    expect(outsiderReplay).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    await emitAck(hostOne, 'chat:send', request);
    expect(
      [hostOneMessages, hostTwoMessages, guestMessages].map((events) => events.length),
    ).toEqual([1, 1, 1]);

    for (let index = 2; index <= 10; index += 1) {
      const ack = ChatSendAckSchema.parse(
        await emitAck(hostOne, 'chat:send', {
          roomId,
          clientRequestId: requestId(),
          content: `message-${index}`,
        }),
      );
      expect(ack.ok).toBe(true);
    }
    const limited = ChatSendAckSchema.parse(
      await emitAck(hostOne, 'chat:send', {
        roomId,
        clientRequestId: requestId(),
        content: 'one-too many',
      }),
    );
    expect(limited).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: expect.any(Number) } },
    });
    const guestStillAllowed = ChatSendAckSchema.parse(
      await emitAck(guestSocket, 'chat:send', {
        roomId,
        clientRequestId: requestId(),
        content: 'guest-has-an-independent-budget',
      }),
    );
    expect(guestStillAllowed.ok).toBe(true);
    expect(
      await mongo.database.collection('messages').countDocuments({ roomId: new ObjectId(roomId) }),
    ).toBe(11);
    expect(
      await mongo.database.collection('rooms').findOne({ _id: new ObjectId(roomId) }),
    ).toMatchObject({ version: 2 });

    const sync = RoomJoinAckSchema.parse(await emitAck(hostOne, 'room:sync', { roomId }));
    if (!sync.ok) throw new Error(sync.error.code);
    expect(sync.data.room.recentMessages).toHaveLength(11);
    const chronological = [...sync.data.room.recentMessages].sort((left, right) =>
      `${left.createdAt}\0${left.id}`.localeCompare(`${right.createdAt}\0${right.id}`),
    );
    expect(sync.data.room.recentMessages).toEqual(chronological);
    expect(new Set(sync.data.room.recentMessages.map((message) => message.id)).size).toBe(11);
  });

  it('applies the real unique MongoDB index under concurrent chat sends outside the gateway queue', async () => {
    const host = await world!.register('chat-index-host@example.test', 'Host');
    const guest = await world!.register('chat-index-guest@example.test', 'Guest');
    const { roomId } = await createLobby(host, guest);
    const input = ChatSendRequestSchema.parse({
      roomId,
      clientRequestId: requestId(),
      content: 'concurrent',
    });
    const results = await Promise.all([
      world!.application.sendChat(host.user, input),
      world!.application.sendChat(host.user, input),
    ]);
    expect(results.filter((result) => result.publish)).toHaveLength(1);
    expect(new Set(results.map((result) => result.message.id)).size).toBe(1);
    expect(await mongo.database.collection('messages').countDocuments()).toBe(1);
    const raw = await mongo.database.collection('messages').findOne({});
    const persisted = ChatMessageDocumentSchema.parse(raw);
    const repository = new MongoChatRepository(mongo.database);
    const racingClientRequestId = requestId();
    const inserts = await Promise.allSettled([
      repository.insert({
        ...persisted,
        _id: new ObjectId(),
        clientRequestId: racingClientRequestId,
      }),
      repository.insert({
        ...persisted,
        _id: new ObjectId(),
        clientRequestId: racingClientRequestId,
      }),
    ]);
    expect(inserts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const duplicate = inserts.find((result) => result.status === 'rejected');
    expect(duplicate?.status).toBe('rejected');
    if (duplicate?.status === 'rejected') {
      expect(duplicate.reason).toBeInstanceOf(DuplicateChatMessageError);
    }
    expect(await mongo.database.collection('messages').countDocuments()).toBe(2);

    const indexes = await mongo.database.collection('messages').indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'messages_room_sender_request_unique',
          unique: true,
          key: { roomId: 1, senderUserId: 1, clientRequestId: 1 },
        }),
        expect.objectContaining({ name: 'messages_room_created_id' }),
        expect.objectContaining({ name: 'messages_deleteAfter_ttl', expireAfterSeconds: 0 }),
      ]),
    );
  });
});

describe('leave receipts, rotation publications and revocation', () => {
  it('replays the exact minimal leave receipt after membership ended without another mutation or event', async () => {
    const host = await world!.register('leave-host@example.test', 'Host');
    const guest = await world!.register('leave-guest@example.test', 'Guest');
    const { roomId } = await createLobby(host, guest);
    const hostSocket = (await join({ cookie: host.cookie }, roomId)).client;
    const guestOne = (await join({ cookie: guest.cookie }, roomId)).client;
    const guestTwo = (await join({ cookie: guest.cookie, transport: 'polling' }, roomId)).client;
    const memberLeftEvents = recordEvents(hostSocket, 'room:member-left');
    const request = { roomId, clientRequestId: requestId(), expectedVersion: 2 };
    const event = nextEvent(hostSocket, 'room:member-left');

    const acknowledgements = await Promise.all([
      emitAck(guestOne, 'room:leave', request),
      emitAck(guestTwo, 'room:leave', request),
    ]);
    const first = RoomLeaveAckSchema.parse(acknowledgements[0]);
    const second = RoomLeaveAckSchema.parse(acknowledgements[1]);
    expect(first).toEqual({ ok: true, data: { roomId, roomVersion: 3, closed: false } });
    expect(second).toEqual(first);
    expect(RoomEventSchema.parse(await event)).toMatchObject({
      type: 'room.member_left',
      version: 3,
      payload: { userId: guest.user.id, status: 'waiting' },
    });
    expect(memberLeftEvents).toHaveLength(1);

    const replayConnection = await world!.connect({ cookie: guest.cookie, transport: 'polling' });
    const replay = RoomLeaveAckSchema.parse(await emitAck(replayConnection, 'room:leave', request));
    expect(replay).toEqual(first);
    expect(Object.keys(replay.ok ? replay.data : {})).toEqual(['roomId', 'roomVersion', 'closed']);
    const withoutReceipt = RoomLeaveAckSchema.parse(
      await emitAck(replayConnection, 'room:leave', {
        ...request,
        clientRequestId: requestId(),
      }),
    );
    expect(withoutReceipt).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(
      await mongo.database.collection('rooms').findOne({ _id: new ObjectId(roomId) }),
    ).toMatchObject({
      version: 3,
      status: 'waiting',
      members: [{ userId: new ObjectId(host.user.id) }],
    });
    expect(memberLeftEvents).toHaveLength(1);

    const hostLeave = RoomLeaveAckSchema.parse(
      await emitAck(hostSocket, 'room:leave', {
        roomId,
        clientRequestId: requestId(),
        expectedVersion: 3,
      }),
    );
    expect(hostLeave).toEqual({ ok: true, data: { roomId, roomVersion: 4, closed: true } });
  });

  it('broadcasts a code-free rotation version before replay and lets members leave without a stale-version conflict', async () => {
    const host = await world!.register('rotation-host@example.test', 'Host');
    const guest = await world!.register('rotation-guest@example.test', 'Guest');
    const { roomId, invitationCode } = await createLobby(host, guest);
    const hostSocket = (await join({ cookie: host.cookie }, roomId)).client;
    const guestSocket = (await join({ cookie: guest.cookie, transport: 'polling' }, roomId)).client;
    const hostEvents = recordEvents(hostSocket, 'room:invitation-rotated');
    const guestEvents = recordEvents(guestSocket, 'room:invitation-rotated');
    const hostEvent = nextEvent(hostSocket, 'room:invitation-rotated');
    const guestEvent = nextEvent(guestSocket, 'room:invitation-rotated');
    const rotationRequest = { clientRequestId: requestId(), expectedVersion: 2 };

    const rotated = RotateInvitationResponseEnvelopeSchema.parse(
      (
        await postAs(world!.app, `/api/v1/rooms/${roomId}/invitation/rotate`, host.cookie)
          .send(rotationRequest)
          .expect(200)
      ).body,
    );
    if (rotated.data.outcome !== 'rotated') throw new Error('Expected a rotated invitation');
    const [forHost, forGuest] = await Promise.all([hostEvent, guestEvent]);
    const hostProjection = RoomEventSchema.parse(forHost);
    const guestProjection = RoomEventSchema.parse(forGuest);
    expect(hostProjection).toEqual(guestProjection);
    expect(hostProjection).toMatchObject({
      type: 'room.invitation_rotated',
      roomId,
      version: 3,
      payload: { expiresAt: rotated.data.invitation.expiresAt },
    });
    expect(
      Object.keys(hostProjection.type === 'room.invitation_rotated' ? hostProjection.payload : {}),
    ).toEqual(['expiresAt']);
    const serialized = JSON.stringify([forHost, forGuest]);
    for (const forbidden of [invitationCode, rotated.data.invitation.code, 'codeHash', 'Receipt']) {
      expect(serialized).not.toContain(forbidden);
    }

    const replay = await postAs(
      world!.app,
      `/api/v1/rooms/${roomId}/invitation/rotate`,
      host.cookie,
    )
      .send(rotationRequest)
      .expect(200);
    expect(replay.body.data).toMatchObject({ outcome: 'replayed', invitation: null });
    expect(hostEvents).toHaveLength(1);
    expect(guestEvents).toHaveLength(1);
    const leave = RoomLeaveAckSchema.parse(
      await emitAck(guestSocket, 'room:leave', {
        roomId,
        clientRequestId: requestId(),
        expectedVersion: hostProjection.version,
      }),
    );
    expect(leave).toEqual({ ok: true, data: { roomId, roomVersion: 4, closed: false } });
  });

  it('disconnects every revoked socket without a domain leave and rechecks authentication on every command', async () => {
    const host = await world!.register('revocation-host@example.test', 'Host');
    const guest = await world!.register('revocation-guest@example.test', 'Guest');
    const { roomId } = await createLobby(host, guest);
    const hostSocket = (await join({ cookie: host.cookie }, roomId)).client;
    const guestOne = (await join({ cookie: guest.cookie }, roomId)).client;
    const guestTwo = (await join({ cookie: guest.cookie, transport: 'polling' }, roomId)).client;
    const disconnectedOne = nextEvent(guestOne, 'disconnect');
    const disconnectedTwo = nextEvent(guestTwo, 'disconnect');
    const offline = nextEvent(hostSocket, 'room:presence');

    await unsafePost(world!.app, '/api/v1/auth/logout').set('Cookie', guest.cookie).expect(204);
    await Promise.all([disconnectedOne, disconnectedTwo]);
    const presence = RoomPresenceEventSchema.parse(await offline);
    expect(presence.members).toEqual([
      { userId: host.user.id, status: 'online', changedAt: expect.any(String) },
      { userId: guest.user.id, status: 'offline', changedAt: expect.any(String) },
    ]);
    expect(
      await mongo.database.collection('rooms').findOne({ _id: new ObjectId(roomId) }),
    ).toMatchObject({
      version: 2,
      members: [{}, {}],
    });
    const reconnectError = await expectConnectError(
      world!.createClient({ cookie: guest.cookie, transport: 'polling' }),
    );
    expect(JSON.stringify(reconnectError)).not.toContain(guest.cookie);
    await mongo.database
      .collection('authSessions')
      .updateOne({ userId: new ObjectId(host.user.id) }, { $set: { revokedAt: new Date() } });
    const rejected = ChatSendAckSchema.parse(
      await emitAck(hostSocket, 'chat:send', {
        roomId,
        clientRequestId: requestId(),
        content: 'must not persist',
      }),
    );
    expect(rejected).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await mongo.database.collection('messages').countDocuments()).toBe(0);
  });
});
