import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CaseListResponseSchema,
  CreateRoomResponseEnvelopeSchema,
  GameEventSchema,
  GameResponseSchema,
  RoomJoinAckSchema,
  RoomStartedEventSchema,
  SuspectQuestionAckSchema,
} from '@casetogether/shared';
import { glockenschlagIds } from '../../src/game-engine/index.js';
import { postAs, requestId, type ActorSession } from '../support/rooms-test-app.js';
import { startMongoTestDatabase, type MongoTestDatabase } from '../support/mongo-test-database.js';
import { emitAck, nextEvent, RealtimeTestWorld, recordEvents } from './support.js';

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
  world = await RealtimeTestWorld.start({ database: mongo.database, game: true });
});

afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function createStartedRoom(host: ActorSession, guest: ActorSession) {
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
  const availableCases = CaseListResponseSchema.parse(
    (await request(world.app).get('/api/v1/cases').set('Cookie', host.cookie).expect(200)).body,
  );
  expect(availableCases.data.items.map((item) => item.id)).toContain(glockenschlagIds.caseId);

  const hostSocket = await world.connect({ cookie: host.cookie });
  const guestSocket = await world.connect({ cookie: guest.cookie });
  for (const socket of [hostSocket, guestSocket]) {
    const joined = RoomJoinAckSchema.parse(await emitAck(socket, 'room:join', { roomId }));
    if (!joined.ok) throw new Error(joined.error.code);
    expect(joined.data.game).toBeNull();
  }
  const hostGameEvents = recordEvents(hostSocket, 'game:event');
  const guestGameEvents = recordEvents(guestSocket, 'game:event');
  const guestRoomEvents = recordEvents(guestSocket, 'room:started');
  const started = GameResponseSchema.parse(
    (
      await postAs(world.app, `/api/v1/rooms/${roomId}/start`, host.cookie)
        .send({
          clientRequestId: requestId(),
          caseId: glockenschlagIds.caseId,
          expectedVersion: 2,
        })
        .expect(200)
    ).body,
  ).data;
  expect(started).toMatchObject({ phase: 'investigating', version: 1, roomId });
  expect(guestRoomEvents.map((event) => RoomStartedEventSchema.parse(event).version)).toEqual([3]);
  expect(hostGameEvents.map((event) => GameEventSchema.parse(event).type)).toEqual([
    'game.started',
  ]);
  expect(guestGameEvents.map((event) => GameEventSchema.parse(event).type)).toEqual([
    'game.started',
  ]);

  return { roomId, started, hostSocket, guestSocket, hostGameEvents };
}

describe('T009 runtime realtime composition', () => {
  it('starts, answers by reference, restores snapshots and completes through the wired app', async () => {
    const host = await world!.register('game-host@example.test', 'Host');
    const guest = await world!.register('game-guest@example.test', 'Gast');
    const { started, hostSocket, guestSocket, hostGameEvents } = await createStartedRoom(
      host,
      guest,
    );
    const guestGameEvents = recordEvents(guestSocket, 'game:event');
    const guestAnswered = nextEvent(guestSocket, 'game:event');
    const response = SuspectQuestionAckSchema.parse(
      await emitAck(hostSocket, 'suspect:question', {
        sessionId: started.sessionId,
        clientRequestId: requestId(),
        expectedVersion: started.version,
        suspectId: glockenschlagIds.suspects.miriam,
        mode: 'catalog',
        questionId: glockenschlagIds.questions.miriamEvening,
      }),
    );
    if (!response.ok) throw new Error(response.error.code);
    expect(response.data.event).toMatchObject({
      type: 'suspect.answered',
      version: 2,
      payload: { dialogue: { answerSource: 'reference' }, phase: 'investigating' },
    });
    expect(GameEventSchema.parse(await guestAnswered)).toMatchObject({
      type: 'suspect.answered',
      payload: { dialogue: { answerSource: 'reference' } },
    });
    expect(guestGameEvents).toHaveLength(1);

    guestSocket.close();
    const reconnectedGuest = await world!.connect({ cookie: guest.cookie, transport: 'polling' });
    const synchronized = RoomJoinAckSchema.parse(
      await emitAck(reconnectedGuest, 'room:sync', { roomId: started.roomId }),
    );
    if (!synchronized.ok) throw new Error(synchronized.error.code);
    expect(synchronized.data.game).toMatchObject({
      sessionId: started.sessionId,
      phase: 'investigating',
      version: 2,
    });

    const completed = GameResponseSchema.parse(
      (
        await postAs(
          world!.app,
          `/api/v1/sessions/${started.sessionId}/final-submission`,
          guest.cookie,
        )
          .send({
            clientRequestId: requestId(),
            expectedVersion: 2,
            suspectId: glockenschlagIds.suspects.miriam,
          })
          .expect(200)
      ).body,
    ).data;
    expect(completed).toMatchObject({
      phase: 'completed',
      version: 3,
      result: { verdict: 'correct' },
      finishedAt: expect.any(String),
    });
    expect(hostGameEvents.map((event) => GameEventSchema.parse(event).type)).toEqual([
      'game.started',
      'suspect.answered',
      'game.completed',
    ]);
  });
});
