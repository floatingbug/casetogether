import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RoomIdSchema, RoomLeaveRequestSchema } from '@casetogether/shared';
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

describe('logical invitation and lobby expiry without depending on the TTL monitor', () => {
  it('rejects an expired lobby independently of a still-valid rotated code and preserves its persisted evidence', async () => {
    const clock = new MutableClock(TEST_NOW);
    const world = await createRoomsTestApp({
      database: mongo.database,
      clock: clock.read,
      invitationGenerator: invitationSequence(TEST_CODE_1, TEST_CODE_2, TEST_CODE_3),
    });
    const host = await registerActor(world.app, 'lobby-expiry-host@example.test', 'Host');
    const guest = await registerActor(world.app, 'lobby-expiry-guest@example.test', 'Guest');
    const created = await postAs(world.app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);
    const roomId = created.body.data.room.id;

    clock.advance(23.5 * 60 * 60 * 1000);
    const rotated = await postAs(
      world.app,
      `/api/v1/rooms/${roomId}/invitation/rotate`,
      host.cookie,
    )
      .send({ clientRequestId: requestId(), expectedVersion: 1 })
      .expect(200);
    expect(rotated.body.data.invitation.code).toBe(TEST_CODE_2);
    expect(new Date(rotated.body.data.invitation.expiresAt).getTime()).toBe(
      TEST_NOW.getTime() + 24.5 * 60 * 60 * 1000,
    );
    const before = await mongo.database.collection('rooms').findOne({});

    clock.advance(30 * 60 * 1000);
    const join = await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
      .send({ clientRequestId: requestId(), code: TEST_CODE_2 })
      .expect(400);
    expect(join.body.error.code).toBe('INVITATION_INVALID');
    const read = await world.roomService
      .getRoom(host.user, RoomIdSchema.parse(roomId))
      .catch((error: unknown) => error);
    expect(read).toMatchObject({ code: 'ROOM_CLOSED' });
    const rotateAfterExpiry = await world.roomService
      .rotateInvitation(host.user, RoomIdSchema.parse(roomId), {
        clientRequestId: requestId(),
        expectedVersion: 2,
      })
      .catch((error: unknown) => error);
    expect(rotateAfterExpiry).toMatchObject({ code: 'ROOM_CLOSED' });
    expect(rotateAfterExpiry).not.toHaveProperty('data.invitation');

    const after = await mongo.database.collection('rooms').findOne({});
    expect(after).toMatchObject({
      status: 'waiting',
      version: 2,
      expiresAt: new Date(TEST_NOW.getTime() + 24 * 60 * 60 * 1000),
      deleteAfter: new Date(TEST_NOW.getTime() + 24 * 60 * 60 * 1000),
      invitation: {
        codeHash: before?.['invitation'].codeHash,
        expiresAt: new Date(TEST_NOW.getTime() + 24.5 * 60 * 60 * 1000),
      },
    });
    expect(after?.['members']).toHaveLength(1);
    expect(after?.['actionReceipts']).toHaveLength(2);
    expect(JSON.stringify(join.body)).not.toContain(TEST_CODE_2);
    expect(JSON.stringify(read)).not.toContain(TEST_CODE_2);
  });
});

describe('room state and HTTP abuse boundaries', () => {
  it('rejects new joins, rotation and leave in an in-progress room without implementing start state', async () => {
    const world = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1),
    });
    const host = await registerActor(world.app, 'in-progress-host@example.test', 'Host');
    const guest = await registerActor(world.app, 'in-progress-guest@example.test', 'Guest');
    const outsider = await registerActor(
      world.app,
      'in-progress-outsider@example.test',
      'Outsider',
    );
    const created = await postAs(world.app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);
    const roomId = created.body.data.room.id;
    await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
      .send({ clientRequestId: requestId(), code: TEST_CODE_1 })
      .expect(200);
    const sessionId = new ObjectId();
    await mongo.database
      .collection('rooms')
      .updateOne(
        { _id: new ObjectId(roomId), version: 2 },
        { $set: { status: 'in_progress', activeSessionId: sessionId } },
      );

    const join = await postAs(world.app, '/api/v1/rooms/join', outsider.cookie)
      .send({ clientRequestId: requestId(), code: TEST_CODE_1 })
      .expect(409);
    expect(join.body.error.code).toBe('ROOM_NOT_JOINABLE');
    const rotate = await postAs(world.app, `/api/v1/rooms/${roomId}/invitation/rotate`, host.cookie)
      .send({ clientRequestId: requestId(), expectedVersion: 2 })
      .expect(409);
    expect(rotate.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const leave = await world.roomService
      .leaveRoom(
        guest.user,
        RoomLeaveRequestSchema.parse({
          roomId,
          clientRequestId: requestId(),
          expectedVersion: 2,
        }),
      )
      .catch((error: unknown) => error);
    expect(leave).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    const snapshot = await world.roomService.getRoom(host.user, RoomIdSchema.parse(roomId));
    expect(snapshot.room).toMatchObject({
      status: 'in_progress',
      version: 2,
      activeSessionId: sessionId.toHexString(),
    });
    expect(snapshot.room.members).toHaveLength(2);
    const raw = await mongo.database.collection('rooms').findOne({});
    expect(raw?.['version']).toBe(2);
    expect(raw?.['members']).toHaveLength(2);
    expect(raw).not.toHaveProperty('startIntent');
    expect(raw).not.toHaveProperty('engineState');
    expect(await mongo.database.listCollections({ name: 'gameSessions' }).toArray()).toHaveLength(
      0,
    );
  });

  it('enforces the per-user join limit through real authenticated HTTP before another code probe', async () => {
    const clock = new MutableClock(TEST_NOW);
    const world = await createRoomsTestApp({ database: mongo.database, clock: clock.read });
    const guest = await registerActor(world.app, 'limited-join@example.test', 'Guest');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const invalid = await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
        .send({ clientRequestId: requestId(), code: TEST_CODE_1 })
        .expect(400);
      expect(invalid.body.error.code).toBe('INVITATION_INVALID');
    }
    const limited = await postAs(world.app, '/api/v1/rooms/join', guest.cookie)
      .send({ clientRequestId: requestId(), code: TEST_CODE_2 })
      .expect(429);
    expect(limited.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 300 },
    });
    expect(limited.headers['retry-after']).toBe('300');
    expect(JSON.stringify(limited.body)).not.toContain(TEST_CODE_1);
    expect(JSON.stringify(limited.body)).not.toContain(TEST_CODE_2);
    expect(await mongo.database.collection('rooms').countDocuments()).toBe(0);
  });
});
