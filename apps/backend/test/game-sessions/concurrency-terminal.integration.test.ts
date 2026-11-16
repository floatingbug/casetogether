import { afterAll, describe, expect, it } from 'vitest';
import { GameAbandonedEventSchema, GameCompletedEventSchema } from '@casetogether/shared';
import { glockenschlagIds } from '../../src/game-engine/index.js';
import {
  type GameSessionRoomRepository,
  MongoGameSessionRepository,
  MongoGameSessionRoomRepository,
} from '../../src/modules/game-sessions/index.js';
import { startMongoTestDatabase } from '../support/mongo-test-database.js';
import {
  RecordingPublicationPort,
  RoomIdForTest,
  createHarness,
  seedGameFixture,
  startFixtureGame,
  startRequest,
  testRequestId,
} from './support.js';

const databaseState = await startMongoTestDatabase();
afterAll(() => databaseState.close());

describe('T009 start recovery, CAS and terminal events', () => {
  it('recovers after the real room CAS and publishes only after recovering the start receipt', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const baseRooms = new MongoGameSessionRoomRepository(databaseState.database);
    let armed = true;
    const rooms: GameSessionRoomRepository = new Proxy(baseRooms, {
      get(target, property, receiver) {
        if (property === 'linkPreparedSession') {
          return async (...args: Parameters<GameSessionRoomRepository['linkPreparedSession']>) => {
            const result = await target.linkPreparedSession(...args);
            if (armed) throw new Error('crash-after-room-cas');
            return result;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const harness = await createHarness(databaseState.database, fixture, { rooms });
    const invoke = () =>
      harness.gameSessions.startGame(
        fixture.host,
        RoomIdForTest(fixture.roomId),
        startRequest(fixture),
      );
    await expect(invoke()).rejects.toThrow('crash-after-room-cas');
    const room = await databaseState.database.collection('rooms').findOne({ _id: fixture.roomId });
    expect(room?.['activeSessionId']).not.toBeNull();
    const session = await databaseState.database
      .collection('gameSessions')
      .findOne({ _id: room?.['activeSessionId'] });
    expect(session?.['actionReceipts']).toHaveLength(0);
    expect(harness.publisher.publications).toHaveLength(0);

    armed = false;
    const recovered = await invoke();
    expect(recovered.data.phase).toBe('investigating');
    expect(harness.publisher.publications).toHaveLength(1);
    expect(session?._id.toHexString()).toBe(recovered.data.sessionId);
    await expect(invoke()).resolves.toMatchObject({ publication: null });
    expect(harness.publisher.publications).toHaveLength(1);
  });

  it('supersedes only the unlinked intent after a definitive CAS loss and allows a fully new start', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const baseRooms = new MongoGameSessionRoomRepository(databaseState.database);
    const database = databaseState.database;
    const rooms: GameSessionRoomRepository = new Proxy(baseRooms, {
      get(target, property, receiver) {
        if (property === 'linkPreparedSession') {
          return async (...args: Parameters<GameSessionRoomRepository['linkPreparedSession']>) => {
            await database
              .collection('rooms')
              .updateOne({ _id: fixture.roomId, version: 1 }, { $inc: { version: 1 } });
            return target.linkPreparedSession(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const harness = await createHarness(databaseState.database, fixture, { rooms });
    await expect(
      harness.gameSessions.startGame(
        fixture.host,
        RoomIdForTest(fixture.roomId),
        startRequest(fixture),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 2 } });
    const superseded = await new MongoGameSessionRepository(database).findByRoomId(fixture.roomId);
    expect(superseded?.startIntent.status).toBe('superseded');
    expect(superseded?.actionReceipts).toHaveLength(0);
    expect(harness.publisher.publications).toHaveLength(0);
    expect((await baseRooms.findById(fixture.roomId))?.activeSessionId).toBeNull();

    const fresh = await createHarness(database, fixture);
    const replacement = { ...startRequest(fixture, 9), expectedVersion: 2 };
    const restarted = await fresh.gameSessions.startGame(
      fixture.host,
      RoomIdForTest(fixture.roomId),
      replacement,
    );
    expect(restarted.data.sessionId).toBe(superseded?._id.toHexString());
    expect(restarted.data.version).toBe(1);
    expect(await database.collection('gameSessions').countDocuments()).toBe(1);
  });

  it('deduplicates parallel identical starts and creates one unique session', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const harness = await createHarness(databaseState.database, fixture);
    const first = harness.gameSessions.startGame(
      fixture.host,
      RoomIdForTest(fixture.roomId),
      startRequest(fixture),
    );
    const second = harness.gameSessions.startGame(
      fixture.host,
      RoomIdForTest(fixture.roomId),
      startRequest(fixture),
    );
    const [one, two] = await Promise.all([first, second]);
    expect(one.data).toEqual(two.data);
    expect([one.publication, two.publication].filter((value) => value !== null)).toHaveLength(1);
    expect(await databaseState.database.collection('gameSessions').countDocuments()).toBe(1);
    expect(
      (await databaseState.database.collection('rooms').findOne({ _id: fixture.roomId }))?.[
        'version'
      ],
    ).toBe(2);
    expect(harness.publisher.publications).toHaveLength(1);
  });

  it('deduplicates identical starts across independently constructed services and publishers', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const firstHarness = await createHarness(databaseState.database, fixture);
    const secondHarness = await createHarness(databaseState.database, fixture);
    const results = await Promise.allSettled([
      firstHarness.gameSessions.startGame(
        fixture.host,
        RoomIdForTest(fixture.roomId),
        startRequest(fixture),
      ),
      secondHarness.gameSessions.startGame(
        fixture.host,
        RoomIdForTest(fixture.roomId),
        startRequest(fixture),
      ),
    ]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(await databaseState.database.collection('gameSessions').countDocuments()).toBe(1);
    expect(
      firstHarness.publisher.publications.length + secondHarness.publisher.publications.length,
    ).toBe(1);
    const session = await new MongoGameSessionRepository(databaseState.database).findByRoomId(
      fixture.roomId,
    );
    expect(
      session?.actionReceipts.filter((receipt) => receipt.operation === 'room:start'),
    ).toHaveLength(1);
    expect(
      (await databaseState.database.collection('rooms').findOne({ _id: fixture.roomId }))?.[
        'version'
      ],
    ).toBe(2);
  });

  it('serializes parallel final submissions with exactly one CAS winner and safe replay', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    let terminalPersistedBeforePublication = false;
    const publicationPort = new RecordingPublicationPort(async (publication) => {
      if (
        publication.kind !== 'events' ||
        !publication.deliveries.some((delivery) => delivery.event.type === 'game.completed')
      ) {
        return;
      }
      const stored = await new MongoGameSessionRepository(databaseState.database).findByRoomId(
        fixture.roomId,
      );
      expect(stored?.phase).toBe('completed');
      expect(stored?.version).toBe(2);
      expect(stored?.finishedAt).toBeInstanceOf(Date);
      expect(stored?.actionReceipts.some((receipt) => receipt.operation === 'game:final')).toBe(
        true,
      );
      terminalPersistedBeforePublication = true;
    });
    const harness = await createHarness(databaseState.database, fixture, { publicationPort });
    const session = await startFixtureGame(harness);
    const request = {
      clientRequestId: testRequestId(20),
      expectedVersion: 1,
      suspectId: glockenschlagIds.suspects.miriam,
    };
    const results = await Promise.all([
      harness.gameSessions.submitFinalSolution(fixture.guest, session.sessionId, request),
      harness.gameSessions.submitFinalSolution(fixture.guest, session.sessionId, request),
    ]);
    expect(results[0].data).toEqual(results[1].data);
    expect(results.map((result) => result.publication).filter(Boolean)).toHaveLength(1);
    expect(results[0].data).toMatchObject({ phase: 'completed', version: 2 });
    expect(results[0].data.finishedAt).not.toBeNull();
    expect(terminalPersistedBeforePublication).toBe(true);
    expect(results[0].data.finalSubmission?.submittedBy.id).toBe(fixture.guest.id);
    expect(results[0].data.result?.resolution.suspectId).toBe(glockenschlagIds.suspects.miriam);
    const completion = results.flatMap((result) => result.publication?.deliveries ?? [])[0]?.event;
    expect(completion).toBeDefined();
    expect(GameCompletedEventSchema.safeParse(completion).success).toBe(true);
    expect(harness.publisher.publications.filter((item) => item.kind === 'events')).toHaveLength(1);
    const stored = await new MongoGameSessionRepository(databaseState.database).findByRoomId(
      fixture.roomId,
    );
    expect(stored?.version).toBe(2);
    expect(
      stored?.actionReceipts.filter((receipt) => receipt.operation === 'game:final'),
    ).toHaveLength(1);
  });

  it('lets only one of two different final requests win the same expected version', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const harness = await createHarness(databaseState.database, fixture);
    const session = await startFixtureGame(harness);
    const submissions = await Promise.allSettled([
      harness.gameSessions.submitFinalSolution(fixture.host, session.sessionId, {
        clientRequestId: testRequestId(21),
        expectedVersion: 1,
        suspectId: glockenschlagIds.suspects.miriam,
      }),
      harness.gameSessions.submitFinalSolution(fixture.guest, session.sessionId, {
        clientRequestId: testRequestId(22),
        expectedVersion: 1,
        suspectId: glockenschlagIds.suspects.jonas,
      }),
    ]);
    expect(submissions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = submissions.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
    const current = await harness.gameSessions.getSession(fixture.host, session.sessionId);
    expect(current.version).toBe(2);
    expect(current.phase).toBe('completed');
    await expect(
      harness.gameSessions.submitFinalSolution(fixture.host, session.sessionId, {
        clientRequestId: testRequestId(23),
        expectedVersion: 2,
        suspectId: glockenschlagIds.suspects.jonas,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('projects an internally abandoned session as complete recipient snapshots without resolution', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const harness = await createHarness(databaseState.database, fixture);
    const session = await startFixtureGame(harness);
    const abandoned = await harness.gameSessions.abandonForServer(session.sessionId, {
      reason: 'server_timeout',
      expectedVersion: 1,
    });
    expect(abandoned.publication?.deliveries).toHaveLength(2);
    for (const delivery of abandoned.publication?.deliveries ?? []) {
      expect(GameAbandonedEventSchema.safeParse(delivery.event).success).toBe(true);
      if (delivery.event.type === 'game.abandoned') {
        expect(delivery.event.payload.snapshot.version).toBe(2);
        expect(delivery.event.payload.snapshot.finishedAt).not.toBeNull();
        expect(delivery.event.payload.snapshot.result).toBeNull();
        expect(delivery.event.payload.snapshot.finalSubmission).toBeNull();
        expect(JSON.stringify(delivery.event)).not.toMatch(/resolution|explanation|culprit/);
      }
    }
    expect((await harness.gameSessions.getSession(fixture.guest, session.sessionId)).phase).toBe(
      'abandoned',
    );
  });
});
