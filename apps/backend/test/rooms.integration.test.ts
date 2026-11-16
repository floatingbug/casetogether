import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  CreateRoomResponseEnvelopeSchema,
  ErrorResponseSchema,
  RotateInvitationResponseEnvelopeSchema,
  RoomResponseSchema,
} from '@casetogether/shared';
import { canonicalizeInvitationCode, hashInvitationCode } from '../src/modules/rooms/invitation.js';
import { unsafePost } from './support/auth-test-app.js';
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

describe('room creation and real MongoDB indexes', () => {
  it('creates every room index idempotently and persists only the invitation hash and a minimal receipt', async () => {
    const { app } = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1),
    });
    const host = await registerActor(app, 'host@example.test', 'Host');
    const clientRequestId = requestId();

    const response = await postAs(app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId })
      .expect(201);
    const body = CreateRoomResponseEnvelopeSchema.parse(response.body);
    expect(body.data).toMatchObject({
      outcome: 'created',
      room: {
        status: 'waiting',
        version: 1,
        maxPlayers: 4,
        activeSessionId: null,
        host: host.user,
        members: [{ user: host.user, role: 'host' }],
      },
      recentMessages: [],
      presence: [],
      invitation: { code: TEST_CODE_1 },
    });
    expect(body.data.outcome).toBe('created');
    if (body.data.outcome !== 'created') {
      throw new Error('Expected a created room');
    }
    expect(
      new Date(body.data.room.expiresAt).getTime() - new Date(body.data.room.createdAt).getTime(),
    ).toBe(24 * 60 * 60 * 1000);
    expect(
      new Date(body.data.invitation.expiresAt).getTime() -
        new Date(body.data.room.createdAt).getTime(),
    ).toBe(60 * 60 * 1000);

    const raw = await mongo.database.collection('rooms').findOne({});
    const serialized = JSON.stringify(raw);
    expect(raw).toMatchObject({
      schemaVersion: 1,
      status: 'waiting',
      version: 1,
      maxPlayers: 4,
      invitation: {
        codeHash: hashInvitationCode(canonicalizeInvitationCode(TEST_CODE_1)),
        createdAt: expect.any(Date),
        expiresAt: expect.any(Date),
      },
      deleteAfter: expect.any(Date),
      actionReceipts: [
        {
          operation: 'create',
          aggregateId: 'new',
          clientRequestId,
          payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          lookupKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          result: { roomVersion: 1, eventId: null, closed: null },
        },
      ],
    });
    expect(raw?.['invitation']).not.toHaveProperty('code');
    expect(serialized).not.toContain(TEST_CODE_1);
    expect(serialized).not.toContain(TEST_CODE_1.replaceAll('-', ''));
    expect(serialized).not.toContain('"outcome":"created"');
    expect(raw).not.toHaveProperty('presence');
    expect(raw).not.toHaveProperty('recentMessages');

    const indexes = await mongo.database.collection('rooms').indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'rooms_invitation_codeHash_unique',
          key: { 'invitation.codeHash': 1 },
          unique: true,
        }),
        expect.objectContaining({ name: 'rooms_id_members_userId' }),
        expect.objectContaining({ name: 'rooms_actionReceipts_actor_operation_request' }),
        expect.objectContaining({
          name: 'rooms_actionReceipts_lookupKey_unique',
          key: { 'actionReceipts.lookupKey': 1 },
          unique: true,
        }),
        expect.objectContaining({
          name: 'rooms_deleteAfter_ttl',
          key: { deleteAfter: 1 },
          expireAfterSeconds: 0,
        }),
      ]),
    );
  });

  it('retries a real duplicate invitation hash without overwriting an existing room or receipt', async () => {
    const { app } = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1, TEST_CODE_1, TEST_CODE_2),
    });
    const host = await registerActor(app, 'collision-host@example.test', 'Host');
    const otherHost = await registerActor(app, 'other-host@example.test', 'Other host');
    const first = await postAs(app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);
    const second = await postAs(app, '/api/v1/rooms', otherHost.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);

    expect(first.body.data.invitation.code).toBe(TEST_CODE_1);
    expect(second.body.data.invitation.code).toBe(TEST_CODE_2);
    expect(await mongo.database.collection('rooms').countDocuments()).toBe(2);
    expect(await mongo.database.collection('rooms').distinct('invitation.codeHash')).toHaveLength(
      2,
    );
    expect(first.body.data.room.host).toEqual(host.user);
    expect(second.body.data.room.host).toEqual(otherHost.user);
  });

  it('retries a colliding rotation candidate without any version effect from the rolled-back CAS attempt', async () => {
    const { app } = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1, TEST_CODE_2, TEST_CODE_1, TEST_CODE_3),
    });
    const host = await registerActor(app, 'rotate-collision-host@example.test', 'Host');
    const otherHost = await registerActor(app, 'rotate-collision-other@example.test', 'Other host');
    const first = await postAs(app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);
    const second = await postAs(app, '/api/v1/rooms', otherHost.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);

    const rotated = await postAs(
      app,
      `/api/v1/rooms/${second.body.data.room.id}/invitation/rotate`,
      otherHost.cookie,
    )
      .send({ clientRequestId: requestId(), expectedVersion: 1 })
      .expect(200);
    expect(rotated.body.data).toMatchObject({
      outcome: 'rotated',
      room: { version: 2 },
      invitation: { code: TEST_CODE_3 },
    });
    const rooms = await mongo.database.collection('rooms').find({}).toArray();
    expect(rooms).toHaveLength(2);
    const firstRaw = rooms.find((room) => room._id.toHexString() === first.body.data.room.id);
    const secondRaw = rooms.find((room) => room._id.toHexString() === second.body.data.room.id);
    expect(firstRaw).toMatchObject({
      version: 1,
      invitation: { codeHash: hashInvitationCode(canonicalizeInvitationCode(TEST_CODE_1)) },
    });
    expect(secondRaw).toMatchObject({
      version: 2,
      invitation: { codeHash: hashInvitationCode(canonicalizeInvitationCode(TEST_CODE_3)) },
    });
    expect(
      secondRaw?.['actionReceipts'].filter(
        (receipt: { operation: string }) => receipt.operation === 'rotate',
      ),
    ).toHaveLength(1);
  });

  it('returns one initial secret and one code-free replay for concurrent identical creates', async () => {
    const { app } = await createRoomsTestApp({ database: mongo.database });
    const host = await registerActor(app, 'parallel-create@example.test', 'Host');
    const clientRequestId = requestId();

    const responses = await Promise.all([
      postAs(app, '/api/v1/rooms', host.cookie).send({ clientRequestId }),
      postAs(app, '/api/v1/rooms', host.cookie).send({ clientRequestId }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const outcomes = responses.map((response) => response.body.data.outcome).sort();
    expect(outcomes).toEqual(['created', 'replayed']);
    const replay = responses.find((response) => response.body.data.outcome === 'replayed');
    expect(replay?.body.data).toEqual({
      outcome: 'replayed',
      roomId: expect.any(String),
      invitation: null,
      recovery: 'rotate_with_new_client_request_id_if_needed',
    });
    const raw = await mongo.database.collection('rooms').findOne({});
    expect(raw?.['version']).toBe(1);
    expect(raw?.['actionReceipts']).toHaveLength(1);
    expect(await mongo.database.collection('rooms').countDocuments()).toBe(1);
  });
});

describe('room HTTP authorization and membership projections', () => {
  it('requires a real auth session and strict room payloads before any mutation', async () => {
    const { app } = await createRoomsTestApp({ database: mongo.database });
    const clientRequestId = requestId();
    const unauthenticated = await unsafePost(app, '/api/v1/rooms')
      .send({ clientRequestId })
      .expect(401);
    expect(ErrorResponseSchema.parse(unauthenticated.body).error.code).toBe('UNAUTHENTICATED');

    const host = await registerActor(app, 'validation-host@example.test', 'Host');
    const withoutOrigin = await request(app)
      .post('/api/v1/rooms')
      .set('Cookie', host.cookie)
      .send({ clientRequestId })
      .expect(403);
    expect(withoutOrigin.body.error.code).toBe('CSRF_REJECTED');
    const invalid = await postAs(app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId, hostUserId: host.user.id })
      .expect(400);
    expect(invalid.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fieldErrors: [{ path: '', code: 'unrecognized_keys' }] },
    });
    expect(JSON.stringify([unauthenticated.body, withoutOrigin.body, invalid.body])).not.toContain(
      host.user.id,
    );
    expect(await mongo.database.collection('rooms').countDocuments()).toBe(0);
  });

  it('joins through a persisted cookie, returns PublicUser-only membership and hides the room from strangers', async () => {
    const { app } = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1),
    });
    const host = await registerActor(app, 'visible-host@example.test', 'Host');
    const guest = await registerActor(app, 'visible-guest@example.test', 'Guest');
    const stranger = await registerActor(app, 'stranger@example.test', 'Stranger');
    const created = await postAs(app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);
    const roomId = created.body.data.room.id;

    const joined = await postAs(app, '/api/v1/rooms/join', guest.cookie)
      .send({ clientRequestId: requestId(), code: TEST_CODE_1 })
      .expect(200);
    const joinBody = RoomResponseSchema.parse(joined.body);
    expect(joinBody.data.room).toMatchObject({
      id: roomId,
      status: 'ready',
      version: 2,
      members: [
        { user: host.user, role: 'host' },
        { user: guest.user, role: 'member' },
      ],
    });
    expect(joinBody.data.presence).toEqual([]);
    expect(joinBody.data.recentMessages).toEqual([]);

    const hostRead = await request(app)
      .get(`/api/v1/rooms/${roomId}`)
      .set('Cookie', host.cookie)
      .expect(200);
    expect(hostRead.body.data).toEqual(joinBody.data);
    await request(app).get(`/api/v1/rooms/${roomId}`).set('Cookie', guest.cookie).expect(200);
    const strangerRead = await request(app)
      .get(`/api/v1/rooms/${roomId}`)
      .set('Cookie', stranger.cookie)
      .expect(404);
    expect(strangerRead.body.error.code).toBe('NOT_FOUND');

    const allTransport = JSON.stringify([joined.body, hostRead.body, strangerRead.body]);
    expect(allTransport).not.toContain(TEST_CODE_1);
    expect(allTransport).not.toContain('codeHash');
    expect(allTransport).not.toContain('actionReceipts');
    expect(allTransport).not.toContain('visible-guest@example.test');
    expect(JSON.stringify(strangerRead.body)).not.toContain('Guest');
  });

  it('rotates only for the host, invalidates the old hash and reports version conflicts without a second effect', async () => {
    const { app } = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1, TEST_CODE_2),
    });
    const host = await registerActor(app, 'rotate-host@example.test', 'Host');
    const guest = await registerActor(app, 'rotate-guest@example.test', 'Guest');
    const stranger = await registerActor(app, 'rotate-stranger@example.test', 'Stranger');
    const created = await postAs(app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);
    const roomId = created.body.data.room.id;

    const rotated = await postAs(app, `/api/v1/rooms/${roomId}/invitation/rotate`, host.cookie)
      .send({ clientRequestId: requestId(), expectedVersion: 1 })
      .expect(200);
    const rotatedBody = RotateInvitationResponseEnvelopeSchema.parse(rotated.body);
    expect(rotatedBody.data).toMatchObject({
      outcome: 'rotated',
      room: { id: roomId, version: 2 },
      invitation: { code: TEST_CODE_2 },
    });

    const oldJoin = await postAs(app, '/api/v1/rooms/join', guest.cookie)
      .send({ clientRequestId: requestId(), code: TEST_CODE_1 })
      .expect(400);
    expect(oldJoin.body.error.code).toBe('INVITATION_INVALID');
    await postAs(app, '/api/v1/rooms/join', guest.cookie)
      .send({ clientRequestId: requestId(), code: TEST_CODE_2 })
      .expect(200);

    const forbidden = await postAs(app, `/api/v1/rooms/${roomId}/invitation/rotate`, guest.cookie)
      .send({ clientRequestId: requestId(), expectedVersion: 3 })
      .expect(403);
    const notFound = await postAs(app, `/api/v1/rooms/${roomId}/invitation/rotate`, stranger.cookie)
      .send({ clientRequestId: requestId(), expectedVersion: 3 })
      .expect(404);
    const conflict = await postAs(app, `/api/v1/rooms/${roomId}/invitation/rotate`, host.cookie)
      .send({ clientRequestId: requestId(), expectedVersion: 1 })
      .expect(409);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
    expect(notFound.body.error.code).toBe('NOT_FOUND');
    expect(conflict.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 3 },
    });
    expect(
      JSON.stringify([oldJoin.body, forbidden.body, notFound.body, conflict.body]),
    ).not.toContain(TEST_CODE_2);
    expect(await mongo.database.collection('rooms').findOne({})).toMatchObject({
      version: 3,
      invitation: { codeHash: hashInvitationCode(canonicalizeInvitationCode(TEST_CODE_2)) },
    });
  });
});

describe('atomic room races against real findOneAndUpdate predicates', () => {
  it('never admits a fifth member under parallel joins and returns exactly one ROOM_FULL for four guests', async () => {
    const { app } = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1),
    });
    const host = await registerActor(app, 'capacity-host@example.test', 'Host');
    const guests: ActorSession[] = [];
    for (let index = 0; index < 4; index += 1) {
      guests.push(await registerActor(app, `capacity-${index}@example.test`, `Guest ${index}`));
    }
    await postAs(app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);

    const responses = await Promise.all(
      guests.map((guest) =>
        postAs(app, '/api/v1/rooms/join', guest.cookie).send({
          clientRequestId: requestId(),
          code: TEST_CODE_1,
        }),
      ),
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(3);
    const full = responses.filter((response) => response.status === 409);
    expect(full).toHaveLength(1);
    expect(full[0]?.body.error.code).toBe('ROOM_FULL');
    const raw = await mongo.database.collection('rooms').findOne({});
    expect(raw?.['members']).toHaveLength(4);
    expect(raw?.['version']).toBe(4);
    expect(raw?.['status']).toBe('ready');
    expect(raw?.['actionReceipts']).toHaveLength(4);
    expect(
      new Set(
        raw?.['members'].map((member: { userId: { toHexString(): string } }) =>
          member.userId.toHexString(),
        ),
      ).size,
    ).toBe(4);
    expect(JSON.stringify(full[0]?.body)).not.toContain(TEST_CODE_1);
  });

  it('persists one membership and one version increment for concurrent identical joins', async () => {
    const { app } = await createRoomsTestApp({
      database: mongo.database,
      invitationGenerator: invitationSequence(TEST_CODE_1),
    });
    const host = await registerActor(app, 'same-join-host@example.test', 'Host');
    const guest = await registerActor(app, 'same-join-guest@example.test', 'Guest');
    await postAs(app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);
    const body = { clientRequestId: requestId(), code: TEST_CODE_1 };

    const responses = await Promise.all([
      postAs(app, '/api/v1/rooms/join', guest.cookie).send(body),
      postAs(app, '/api/v1/rooms/join', guest.cookie).send(body),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const raw = await mongo.database.collection('rooms').findOne({});
    expect(raw?.['members']).toHaveLength(2);
    expect(raw?.['version']).toBe(2);
    expect(
      raw?.['actionReceipts'].filter(
        (receipt: { operation: string; clientRequestId: string }) =>
          receipt.operation === 'join' && receipt.clientRequestId === body.clientRequestId,
      ),
    ).toHaveLength(1);
  });

  it('resolves concurrent identical rotations as one rotated secret and one replay', async () => {
    const { app } = await createRoomsTestApp({ database: mongo.database });
    const host = await registerActor(app, 'same-rotate-host@example.test', 'Host');
    const created = await postAs(app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);
    const body = { clientRequestId: requestId(), expectedVersion: 1 };

    const responses = await Promise.all([
      postAs(app, `/api/v1/rooms/${created.body.data.room.id}/invitation/rotate`, host.cookie).send(
        body,
      ),
      postAs(app, `/api/v1/rooms/${created.body.data.room.id}/invitation/rotate`, host.cookie).send(
        body,
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.body.data.outcome).sort()).toEqual([
      'replayed',
      'rotated',
    ]);
    const raw = await mongo.database.collection('rooms').findOne({});
    expect(raw?.['version']).toBe(2);
    expect(
      raw?.['actionReceipts'].filter(
        (receipt: { operation: string }) => receipt.operation === 'rotate',
      ),
    ).toHaveLength(1);
  });

  it('lets only one different rotation win an expected-version CAS', async () => {
    const { app } = await createRoomsTestApp({ database: mongo.database });
    const host = await registerActor(app, 'cas-rotate-host@example.test', 'Host');
    const created = await postAs(app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);

    const responses = await Promise.all([
      postAs(app, `/api/v1/rooms/${created.body.data.room.id}/invitation/rotate`, host.cookie).send(
        {
          clientRequestId: requestId(),
          expectedVersion: 1,
        },
      ),
      postAs(app, `/api/v1/rooms/${created.body.data.room.id}/invitation/rotate`, host.cookie).send(
        {
          clientRequestId: requestId(),
          expectedVersion: 1,
        },
      ),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const conflict = responses.find((response) => response.status === 409);
    expect(conflict?.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 2 },
    });
    expect(conflict?.body.data).toBeUndefined();
    const raw = await mongo.database.collection('rooms').findOne({});
    expect(raw?.['version']).toBe(2);
    expect(
      raw?.['actionReceipts'].filter(
        (receipt: { operation: string }) => receipt.operation === 'rotate',
      ),
    ).toHaveLength(1);
  });
});
