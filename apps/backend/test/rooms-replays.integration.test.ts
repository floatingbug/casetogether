import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ErrorResponseSchema,
  RoomEventSchema,
  RoomIdSchema,
  RoomLeaveRequestSchema,
  RoomResponseSchema,
  SecretReplayResponseSchema,
} from '@casetogether/shared';
import { MutableClock, TEST_NOW } from './support/auth-test-app.js';
import { startMongoTestDatabase, type MongoTestDatabase } from './support/mongo-test-database.js';
import {
  createRoomsTestApp,
  invitationSequence,
  postAs,
  registerActor,
  requestId,
  resetRoomsTestDatabase,
  TEST_CODE_1,
  TEST_CODE_2,
  TEST_CODE_3,
  type ActorSession,
  type RoomsTestApp,
} from './support/rooms-test-app.js';

let mongo: MongoTestDatabase;

beforeAll(async () => {
  mongo = await startMongoTestDatabase();
});

afterAll(async () => {
  await mongo.close();
});

beforeEach(async () => {
  await resetRoomsTestDatabase(mongo.database);
});

async function createLobby(
  world: RoomsTestApp,
  host: ActorSession,
): Promise<{ roomId: string; response: request.Response }> {
  const response = await postAs(world.app, '/api/v1/rooms', host.cookie)
    .send({ clientRequestId: requestId() })
    .expect(201);
  return { roomId: response.body.data.room.id, response };
}

describe('persistent secret replays after service recreation', () => {
  it('replays create after restart without regenerating or recovering the plaintext code', async () => {
    const generator = invitationSequence(TEST_CODE_1, TEST_CODE_2);
    const firstWorld = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: generator,
    });
    const host = await registerActor(firstWorld.app, 'restart-create@example.test', 'Host');
    const clientRequestId = requestId();
    const created = await postAs(firstWorld.app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId })
      .expect(201);
    const before = await mongo.database.collection('rooms').findOne({});
    const originalHash = before?.['invitation'].codeHash;

    const restartedWorld = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: generator,
    });
    const replayed = await postAs(restartedWorld.app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId })
      .expect(200);
    expect(SecretReplayResponseSchema.parse(replayed.body.data)).toEqual({
      outcome: 'replayed',
      roomId: created.body.data.room.id,
      invitation: null,
      recovery: 'rotate_with_new_client_request_id_if_needed',
    });
    expect(replayed.body.data).not.toHaveProperty('room');
    expect(replayed.body.data).not.toHaveProperty('members');
    expect(JSON.stringify(replayed.body)).not.toContain(TEST_CODE_1);
    expect(await mongo.database.collection('rooms').findOne({})).toMatchObject({
      version: 1,
      invitation: { codeHash: originalHash },
      actionReceipts: [{ operation: 'create' }],
    });

    const explicitRecovery = await postAs(
      restartedWorld.app,
      `/api/v1/rooms/${created.body.data.room.id}/invitation/rotate`,
      host.cookie,
    )
      .send({ clientRequestId: requestId(), expectedVersion: 1 })
      .expect(200);
    expect(explicitRecovery.body.data).toMatchObject({
      outcome: 'rotated',
      room: { version: 2 },
      invitation: { code: TEST_CODE_2 },
    });
  });

  it('replays rotate after restart with the identical hash/version and requires a new request for another code', async () => {
    const generator = invitationSequence(TEST_CODE_1, TEST_CODE_2, TEST_CODE_3);
    const firstWorld = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: generator,
    });
    const host = await registerActor(firstWorld.app, 'restart-rotate@example.test', 'Host');
    const { roomId } = await createLobby(firstWorld, host);
    const clientRequestId = requestId();
    const rotated = await postAs(
      firstWorld.app,
      `/api/v1/rooms/${roomId}/invitation/rotate`,
      host.cookie,
    )
      .send({ clientRequestId, expectedVersion: 1 })
      .expect(200);
    expect(rotated.body.data.invitation.code).toBe(TEST_CODE_2);
    const before = await mongo.database.collection('rooms').findOne({});
    const originalHash = before?.['invitation'].codeHash;
    const receiptCount = before?.['actionReceipts'].length;

    const restartedWorld = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: generator,
    });
    const replayed = await postAs(
      restartedWorld.app,
      `/api/v1/rooms/${roomId}/invitation/rotate`,
      host.cookie,
    )
      .send({ clientRequestId, expectedVersion: 1 })
      .expect(200);
    expect(SecretReplayResponseSchema.parse(replayed.body.data)).toEqual({
      outcome: 'replayed',
      roomId,
      invitation: null,
      recovery: 'rotate_with_new_client_request_id_if_needed',
    });
    expect(JSON.stringify(replayed.body)).not.toContain(TEST_CODE_2);
    const afterReplay = await mongo.database.collection('rooms').findOne({});
    expect(afterReplay).toMatchObject({ version: 2, invitation: { codeHash: originalHash } });
    expect(afterReplay?.['actionReceipts']).toHaveLength(receiptCount);

    const reusedPayload = await postAs(
      restartedWorld.app,
      `/api/v1/rooms/${roomId}/invitation/rotate`,
      host.cookie,
    )
      .send({ clientRequestId, expectedVersion: 2 })
      .expect(409);
    expect(reusedPayload.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(JSON.stringify(reusedPayload.body)).not.toContain(TEST_CODE_2);
    expect(await mongo.database.collection('rooms').findOne({})).toMatchObject({
      version: 2,
      invitation: { codeHash: originalHash },
    });

    const next = await postAs(
      restartedWorld.app,
      `/api/v1/rooms/${roomId}/invitation/rotate`,
      host.cookie,
    )
      .send({ clientRequestId: requestId(), expectedVersion: 2 })
      .expect(200);
    expect(next.body.data).toMatchObject({
      outcome: 'rotated',
      room: { version: 3 },
      invitation: { code: TEST_CODE_3 },
    });
    expect(next.body.data.invitation.code).not.toBe(TEST_CODE_1);
    expect(next.body.data.invitation.code).not.toBe(TEST_CODE_2);
  });
});

describe('join and no-op replay authorization', () => {
  it('re-identifies an old join after rotation/restart and keeps the current room snapshot code-free', async () => {
    const generator = invitationSequence(TEST_CODE_1, TEST_CODE_2);
    const firstWorld = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: generator,
    });
    const host = await registerActor(firstWorld.app, 'old-join-host@example.test', 'Host');
    const guest = await registerActor(firstWorld.app, 'old-join-guest@example.test', 'Guest');
    const { roomId } = await createLobby(firstWorld, host);
    const joinRequest = { clientRequestId: requestId(), code: TEST_CODE_1 };
    await postAs(firstWorld.app, '/api/v1/rooms/join', guest.cookie).send(joinRequest).expect(200);
    await postAs(firstWorld.app, `/api/v1/rooms/${roomId}/invitation/rotate`, host.cookie)
      .send({ clientRequestId: requestId(), expectedVersion: 2 })
      .expect(200);
    const before = await mongo.database.collection('rooms').findOne({});
    const receiptCount = before?.['actionReceipts'].length;

    const restartedWorld = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: generator,
    });
    const replayed = await postAs(restartedWorld.app, '/api/v1/rooms/join', guest.cookie)
      .send(joinRequest)
      .expect(200);
    const snapshot = RoomResponseSchema.parse(replayed.body).data;
    expect(snapshot.room).toMatchObject({ id: roomId, version: 3, status: 'ready' });
    expect(snapshot.room.members.map((member) => member.user.id)).toEqual([
      host.user.id,
      guest.user.id,
    ]);
    expect(JSON.stringify(replayed.body)).not.toContain(TEST_CODE_1);
    expect(JSON.stringify(replayed.body)).not.toContain(TEST_CODE_2);
    expect(JSON.stringify(replayed.body)).not.toContain('actionReceipts');
    const after = await mongo.database.collection('rooms').findOne({});
    expect(after?.['version']).toBe(3);
    expect(after?.['actionReceipts']).toHaveLength(receiptCount);

    const oldCodeNewRequest = await postAs(restartedWorld.app, '/api/v1/rooms/join', guest.cookie)
      .send({ clientRequestId: requestId(), code: TEST_CODE_1 })
      .expect(400);
    expect(oldCodeNewRequest.body.error.code).toBe('INVITATION_INVALID');
  });

  it('replays join and stores a version-neutral no-op after invitation expiry only for a current member', async () => {
    const clock = new MutableClock(TEST_NOW);
    const world = await createRoomsTestApp({
      database: mongo.database,
      clock: clock.read,
      invitationGenerator: invitationSequence(TEST_CODE_1),
    });
    const host = await registerActor(world.app, 'expired-replay-host@example.test', 'Host');
    const guest = await registerActor(world.app, 'expired-replay-guest@example.test', 'Guest');
    await createLobby(world, host);
    const joinRequest = { clientRequestId: requestId(), code: TEST_CODE_1 };
    await postAs(world.app, '/api/v1/rooms/join', guest.cookie).send(joinRequest).expect(200);

    clock.advance(60 * 60 * 1000);
    const replayed = await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
      .send(joinRequest)
      .expect(200);
    expect(replayed.body.data.room.version).toBe(2);
    const noOpRequest = { clientRequestId: requestId(), code: TEST_CODE_1 };
    const noOp = await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
      .send(noOpRequest)
      .expect(200);
    expect(noOp.body.data.room.members).toHaveLength(2);
    const raw = await mongo.database.collection('rooms').findOne({});
    expect(raw?.['version']).toBe(2);
    expect(
      raw?.['actionReceipts'].filter(
        (receipt: { operation: string }) => receipt.operation === 'join',
      ),
    ).toHaveLength(2);

    const stranger = await registerActor(world.app, 'expiry-stranger@example.test', 'Stranger');
    const invalid = await postAs(world.app, '/api/v1/rooms/join', stranger.cookie)
      .send({ clientRequestId: requestId(), code: TEST_CODE_1 })
      .expect(400);
    expect(invalid.body.error.code).toBe('INVITATION_INVALID');
  });

  it('keeps a full-room no-op idempotent and replays its receipt after rotation without a version effect', async () => {
    const generator = invitationSequence(TEST_CODE_1, TEST_CODE_2);
    const world = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: generator,
    });
    const host = await registerActor(world.app, 'full-noop-host@example.test', 'Host');
    const guests: ActorSession[] = [];
    for (let index = 0; index < 3; index += 1) {
      guests.push(
        await registerActor(world.app, `full-noop-${index}@example.test`, `Guest ${index}`),
      );
    }
    const { roomId } = await createLobby(world, host);
    for (const guest of guests) {
      await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
        .send({ clientRequestId: requestId(), code: TEST_CODE_1 })
        .expect(200);
    }
    const currentGuest = guests[1];
    if (currentGuest === undefined) {
      throw new Error('Expected a guest fixture');
    }
    const noOpRequest = { clientRequestId: requestId(), code: TEST_CODE_1 };
    const noOp = await postAs(world.app, '/api/v1/rooms/join', currentGuest.cookie)
      .send(noOpRequest)
      .expect(200);
    expect(noOp.body.data.room.members).toHaveLength(4);
    expect(noOp.body.data.room.version).toBe(4);
    await postAs(world.app, `/api/v1/rooms/${roomId}/invitation/rotate`, host.cookie)
      .send({ clientRequestId: requestId(), expectedVersion: 4 })
      .expect(200);
    const before = await mongo.database.collection('rooms').findOne({});
    const receiptCount = before?.['actionReceipts'].length;

    const replay = await postAs(world.app, '/api/v1/rooms/join', currentGuest.cookie)
      .send(noOpRequest)
      .expect(200);
    expect(replay.body.data.room.version).toBe(5);
    expect(replay.body.data.room.members).toHaveLength(4);
    const after = await mongo.database.collection('rooms').findOne({});
    expect(after?.['version']).toBe(5);
    expect(after?.['actionReceipts']).toHaveLength(receiptCount);
  });

  it('returns NOT_FOUND rather than an old rich join snapshot after the member leaves', async () => {
    const world = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1),
    });
    const host = await registerActor(world.app, 'former-host@example.test', 'Host');
    const guest = await registerActor(world.app, 'former-guest@example.test', 'Former guest');
    const { roomId } = await createLobby(world, host);
    const joinRequest = { clientRequestId: requestId(), code: TEST_CODE_1 };
    await postAs(world.app, '/api/v1/rooms/join', guest.cookie).send(joinRequest).expect(200);
    await world.roomService.leaveRoom(
      guest.user,
      RoomLeaveRequestSchema.parse({ roomId, clientRequestId: requestId(), expectedVersion: 2 }),
    );

    const replay = await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
      .send(joinRequest)
      .expect(404);
    expect(ErrorResponseSchema.parse(replay.body).error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(replay.body)).not.toContain('Host');
    expect(JSON.stringify(replay.body)).not.toContain(TEST_CODE_1);
    const get = await request(world.app)
      .get(`/api/v1/rooms/${roomId}`)
      .set('Cookie', guest.cookie)
      .expect(404);
    expect(get.body.error.code).toBe('NOT_FOUND');
  });

  it('detects payload reuse after an exact actor/request receipt lookup without revealing private data', async () => {
    const world = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1),
    });
    const host = await registerActor(world.app, 'reuse-host@example.test', 'Host');
    const guest = await registerActor(world.app, 'reuse-guest@example.test', 'Guest');
    await createLobby(world, host);
    const reusedRequestId = requestId();
    await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
      .send({ clientRequestId: reusedRequestId, code: TEST_CODE_1 })
      .expect(200);

    const conflict = await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
      .send({ clientRequestId: reusedRequestId, code: TEST_CODE_2 })
      .expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(JSON.stringify(conflict.body)).not.toContain(TEST_CODE_1);
    expect(JSON.stringify(conflict.body)).not.toContain(TEST_CODE_2);
    expect(JSON.stringify(conflict.body)).not.toContain('Host');
    expect(await mongo.database.collection('rooms').findOne({})).toMatchObject({ version: 2 });
  });
});

describe('leave use cases, minimal receipts and event material', () => {
  it('emits one secret-free member-left event and replays only the minimal leave result after restart', async () => {
    const world = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1),
    });
    const host = await registerActor(world.app, 'leave-host@example.test', 'Host');
    const guest = await registerActor(world.app, 'leave-guest@example.test', 'Guest');
    const { roomId } = await createLobby(world, host);
    await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
      .send({ clientRequestId: requestId(), code: TEST_CODE_1 })
      .expect(200);
    const leave = RoomLeaveRequestSchema.parse({
      roomId,
      clientRequestId: requestId(),
      expectedVersion: 2,
    });

    const first = await world.roomService.leaveRoom(guest.user, leave);
    expect(first.data).toEqual({ roomId, roomVersion: 3, closed: false });
    expect(first.publication?.recipientUserIds).toEqual([host.user.id]);
    expect(RoomEventSchema.parse(first.publication?.event)).toMatchObject({
      type: 'room.member_left',
      roomId,
      version: 3,
      payload: { userId: guest.user.id, status: 'waiting' },
    });
    expect(JSON.stringify(first.publication)).not.toContain('actionReceipts');
    expect(JSON.stringify(first.publication)).not.toContain('codeHash');
    expect(JSON.stringify(first.data)).not.toContain('members');

    const restarted = await createRoomsTestApp({ database: mongo.database });
    const replay = await restarted.roomService.leaveRoom(guest.user, leave);
    expect(replay).toEqual({ data: first.data, publication: null });
    const differentPayload = await restarted.roomService
      .leaveRoom(guest.user, { ...leave, expectedVersion: 3 })
      .catch((error: unknown) => error);
    expect(differentPayload).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const newLeave = await restarted.roomService
      .leaveRoom(
        guest.user,
        RoomLeaveRequestSchema.parse({
          roomId,
          clientRequestId: requestId(),
          expectedVersion: 3,
        }),
      )
      .catch((error: unknown) => error);
    expect(newLeave).toMatchObject({ code: 'NOT_FOUND' });
    expect(await mongo.database.collection('rooms').findOne({})).toMatchObject({
      status: 'waiting',
      version: 3,
      members: [{ role: 'host' }],
    });
  });

  it('closes a lobby on host leave, emits room.closed and preserves only minimal replay semantics', async () => {
    const world = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1),
    });
    const host = await registerActor(world.app, 'close-host@example.test', 'Host');
    const guest = await registerActor(world.app, 'close-guest@example.test', 'Guest');
    const stranger = await registerActor(world.app, 'close-stranger@example.test', 'Stranger');
    const { roomId } = await createLobby(world, host);
    const joinRequest = { clientRequestId: requestId(), code: TEST_CODE_1 };
    await postAs(world.app, '/api/v1/rooms/join', guest.cookie).send(joinRequest).expect(200);
    const leave = RoomLeaveRequestSchema.parse({
      roomId,
      clientRequestId: requestId(),
      expectedVersion: 2,
    });

    const closed = await world.roomService.leaveRoom(host.user, leave);
    expect(closed.data).toEqual({ roomId, roomVersion: 3, closed: true });
    expect(closed.publication?.recipientUserIds).toEqual([host.user.id, guest.user.id]);
    expect(closed.publication?.event).toMatchObject({
      type: 'room.closed',
      version: 3,
      payload: { reason: 'host_left' },
    });
    const restarted = await createRoomsTestApp({ database: mongo.database });
    expect(await restarted.roomService.leaveRoom(host.user, leave)).toEqual({
      data: closed.data,
      publication: null,
    });

    const hostRead = await request(restarted.app)
      .get(`/api/v1/rooms/${roomId}`)
      .set('Cookie', host.cookie)
      .expect(410);
    expect(hostRead.body.error.code).toBe('ROOM_CLOSED');
    const joinAfterClose = await postAs(restarted.app, '/api/v1/rooms/join', guest.cookie)
      .send(joinRequest)
      .expect(410);
    expect(joinAfterClose.body.error.code).toBe('ROOM_CLOSED');
    const currentMemberLeave = await restarted.roomService
      .leaveRoom(
        guest.user,
        RoomLeaveRequestSchema.parse({
          roomId,
          clientRequestId: requestId(),
          expectedVersion: 3,
        }),
      )
      .catch((error: unknown) => error);
    expect(currentMemberLeave).toMatchObject({ code: 'ROOM_CLOSED' });
    const nonMemberLeave = await restarted.roomService
      .leaveRoom(
        stranger.user,
        RoomLeaveRequestSchema.parse({
          roomId,
          clientRequestId: requestId(),
          expectedVersion: 3,
        }),
      )
      .catch((error: unknown) => error);
    expect(nonMemberLeave).toMatchObject({ code: 'NOT_FOUND' });
    const serializedNegative = JSON.stringify([
      hostRead.body,
      joinAfterClose.body,
      currentMemberLeave,
      nonMemberLeave,
    ]);
    expect(serializedNegative).not.toContain(TEST_CODE_1);
    expect(serializedNegative).not.toContain('actionReceipts');
    expect(await mongo.database.collection('rooms').findOne({})).toMatchObject({
      status: 'closed',
      version: 3,
      members: [{ role: 'host' }, { role: 'member' }],
    });
  });

  it('uses RoomInvitationRotatedEventSchema material without code, hash or receipt and no replay broadcast', async () => {
    const world = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1, TEST_CODE_2),
    });
    const host = await registerActor(world.app, 'event-host@example.test', 'Host');
    const guest = await registerActor(world.app, 'event-guest@example.test', 'Guest');
    const { roomId } = await createLobby(world, host);
    await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
      .send({ clientRequestId: requestId(), code: TEST_CODE_1 })
      .expect(200);
    const rotate = {
      clientRequestId: requestId(),
      expectedVersion: 2,
    };

    const first = await world.roomService.rotateInvitation(
      host.user,
      RoomIdSchema.parse(roomId),
      rotate,
    );
    expect(first.publication?.recipientUserIds).toEqual([host.user.id, guest.user.id]);
    expect(RoomEventSchema.parse(first.publication?.event)).toMatchObject({
      type: 'room.invitation_rotated',
      roomId,
      version: 3,
      payload: { expiresAt: expect.any(String) },
    });
    const serializedEvent = JSON.stringify(first.publication);
    expect(serializedEvent).not.toContain(TEST_CODE_2);
    expect(serializedEvent).not.toContain('codeHash');
    expect(serializedEvent).not.toContain('lookupKey');
    expect(serializedEvent).not.toContain('payloadHash');
    expect(serializedEvent).not.toContain('actionReceipts');

    const replay = await world.roomService.rotateInvitation(
      host.user,
      RoomIdSchema.parse(roomId),
      rotate,
    );
    expect(replay.publication).toBeNull();
    expect(replay.data).toMatchObject({ outcome: 'replayed', invitation: null });
    expect(await mongo.database.collection('rooms').findOne({})).toMatchObject({ version: 3 });
  });

  it('allows one of two different member leaves to win CAS and leaves the loser a conflict, not another increment', async () => {
    const world = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1),
    });
    const host = await registerActor(world.app, 'leave-cas-host@example.test', 'Host');
    const firstGuest = await registerActor(world.app, 'leave-cas-a@example.test', 'Guest A');
    const secondGuest = await registerActor(world.app, 'leave-cas-b@example.test', 'Guest B');
    const { roomId } = await createLobby(world, host);
    for (const guest of [firstGuest, secondGuest]) {
      await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
        .send({ clientRequestId: requestId(), code: TEST_CODE_1 })
        .expect(200);
    }

    const outcomes = await Promise.all([
      world.roomService
        .leaveRoom(
          firstGuest.user,
          RoomLeaveRequestSchema.parse({
            roomId,
            clientRequestId: requestId(),
            expectedVersion: 3,
          }),
        )
        .then((result) => ({ status: 'left' as const, result }))
        .catch((error: unknown) => ({ status: 'error' as const, error })),
      world.roomService
        .leaveRoom(
          secondGuest.user,
          RoomLeaveRequestSchema.parse({
            roomId,
            clientRequestId: requestId(),
            expectedVersion: 3,
          }),
        )
        .then((result) => ({ status: 'left' as const, result }))
        .catch((error: unknown) => ({ status: 'error' as const, error })),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'left')).toHaveLength(1);
    const failures = outcomes.filter((outcome) => outcome.status === 'error');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      error: { code: 'VERSION_CONFLICT', details: { currentVersion: 4 } },
    });
    const raw = await mongo.database.collection('rooms').findOne({});
    expect(raw?.['version']).toBe(4);
    expect(raw?.['members']).toHaveLength(2);
    expect(raw?.['status']).toBe('ready');
    expect(
      raw?.['actionReceipts'].filter(
        (receipt: { operation: string }) => receipt.operation === 'leave',
      ),
    ).toHaveLength(1);
  });
});
