import { afterAll, describe, expect, it } from 'vitest';
import { GameSnapshotSchema } from '@casetogether/shared';
import { ObjectId } from 'mongodb';
import {
  type GameSessionRepository,
  MongoGameSessionRepository,
} from '../../src/modules/game-sessions/index.js';
import { startMongoTestDatabase } from '../support/mongo-test-database.js';
import {
  RecordingPublicationPort,
  RoomIdForTest,
  createHarness,
  seedGameFixture,
  startRequest,
} from './support.js';

const databaseState = await startMongoTestDatabase();
afterAll(() => databaseState.close());

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('T009 game-session lifecycle with real MongoDB', () => {
  it('starts safely, lists only public cases and projects authorized snapshots for 2–4 members', async () => {
    for (const count of [2, 4]) {
      const fixture = await seedGameFixture(databaseState.database, count);
      const harness = await createHarness(databaseState.database, fixture);
      const cases = await harness.gameSessions.listCases();
      expect(cases.items).toHaveLength(1);
      expect(JSON.stringify(cases)).not.toMatch(/referenceAnswer|solution|trigger|truth|secret/i);

      const result = await harness.gameSessions.startGame(
        fixture.host,
        RoomIdForTest(fixture.roomId),
        startRequest(fixture),
      );
      expect(result.data).toMatchObject({
        roomId: fixture.roomId.toHexString(),
        caseVersion: '1.0.0',
        phase: 'investigating',
        version: 1,
        finishedAt: null,
      });
      expect(result.data.members).toHaveLength(count);
      expect(result.publication?.kind).toBe('start');
      expect(harness.publisher.publications).toHaveLength(1);
      const publication = harness.publisher.publications[0];
      if (publication?.kind !== 'start') {
        throw new Error('Expected a full start publication');
      }
      expect(publication.roomEvent.version).toBe(2);
      expect(publication.deliveries).toHaveLength(count);
      for (const delivery of publication.deliveries) {
        expect(delivery.event.type).toBe('game.started');
        if (delivery.event.type === 'game.started') {
          expect(GameSnapshotSchema.safeParse(delivery.event.payload.snapshot).success).toBe(true);
        }
      }
      const rawRoom = await databaseState.database
        .collection('rooms')
        .findOne({ _id: fixture.roomId });
      expect(rawRoom).toMatchObject({ status: 'in_progress', version: 2 });
      expect(rawRoom?.['activeSessionId']?.toHexString()).toBe(result.data.sessionId);
      expect(rawRoom?.['deleteAfter']).toBeNull();
      expect(JSON.stringify(result.data)).not.toMatch(
        /startIntent|aiUsage|referenceAnswer|concealedFact|tabooTopics|payloadHash/,
      );

      for (const member of result.data.members) {
        const snapshot = await harness.gameSessions.getSession(member.user, result.data.sessionId);
        expect(GameSnapshotSchema.safeParse(snapshot).success).toBe(true);
      }
      await expectCode(
        harness.gameSessions.getSession(fixture.outsider, result.data.sessionId),
        'NOT_FOUND',
      );
    }
  });

  it('pins the latest published case version and one summary and keeps it readable after retirement', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const cases = databaseState.database.collection('cases');
    const first = await cases.findOne({ version: '1.0.0' });
    if (first === null) throw new Error('Expected seeded case');
    await cases.insertOne({ ...first, _id: new ObjectId(), version: '2.0.0' });
    await cases.updateOne({ version: '1.0.0' }, { $set: { status: 'retired' } });
    const harness = await createHarness(databaseState.database, fixture);
    expect((await harness.gameSessions.listCases()).items).toHaveLength(1);
    const started = await harness.gameSessions.startGame(
      fixture.host,
      RoomIdForTest(fixture.roomId),
      startRequest(fixture),
    );
    expect(started.data.caseVersion).toBe('2.0.0');
    await cases.updateOne({ version: '2.0.0' }, { $set: { status: 'retired' } });
    await expect(
      harness.gameSessions.getSession(fixture.guest, started.data.sessionId),
    ).resolves.toMatchObject({ caseVersion: '2.0.0', phase: 'investigating' });
  });

  it('publishes strictly after room link and start receipt persistence and makes replays mutation-free', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const publisher = new RecordingPublicationPort(async () => {
      const room = await databaseState.database
        .collection('rooms')
        .findOne({ _id: fixture.roomId });
      expect(room?.['activeSessionId']).toBeInstanceOf(Object);
      const session = await databaseState.database
        .collection('gameSessions')
        .findOne({ _id: room?.['activeSessionId'] });
      expect(session?.['startIntent']?.['status']).toBe('prepared');
      expect(session?.['actionReceipts']).toHaveLength(1);
    });
    const harness = await createHarness(databaseState.database, fixture, {
      publicationPort: publisher,
    });
    const first = await harness.gameSessions.startGame(
      fixture.host,
      RoomIdForTest(fixture.roomId),
      startRequest(fixture),
    );
    const replay = await harness.gameSessions.startGame(
      fixture.host,
      RoomIdForTest(fixture.roomId),
      startRequest(fixture),
    );
    expect(replay.publication).toBeNull();
    expect(replay.data).toEqual(first.data);
    expect(publisher.publications).toHaveLength(1);
    expect(await databaseState.database.collection('gameSessions').countDocuments()).toBe(1);
  });

  it('never exposes or adopts a foreign pending start and preserves scope conflicts', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const base = new MongoGameSessionRepository(databaseState.database);
    const sessions: GameSessionRepository = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'insertPendingStart') {
          return async (session: Parameters<GameSessionRepository['insertPendingStart']>[0]) => {
            await target.insertPendingStart(session);
            throw new Error('simulated crash after pending insert');
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const crashed = await createHarness(databaseState.database, fixture, { sessions });
    await expect(
      crashed.gameSessions.startGame(
        fixture.host,
        RoomIdForTest(fixture.roomId),
        startRequest(fixture),
      ),
    ).rejects.toThrow('simulated crash after pending insert');
    const pending = await base.findByRoomId(fixture.roomId);
    if (pending === null) throw new Error('Expected persisted pending intent');
    expect(pending.startIntent.status).toBe('pending');
    expect(pending.actionReceipts).toHaveLength(0);

    const recovery = await createHarness(databaseState.database, fixture);
    await expectCode(
      recovery.gameSessions.getSession(fixture.host, pending._id.toHexString()),
      'NOT_FOUND',
    );
    await expectCode(
      recovery.gameSessions.startGame(
        fixture.host,
        RoomIdForTest(fixture.roomId),
        startRequest(fixture, 2),
      ),
      'OPERATION_IN_PROGRESS',
    );
    await expectCode(
      recovery.gameSessions.startGame(fixture.host, RoomIdForTest(fixture.roomId), {
        ...startRequest(fixture),
        expectedVersion: 2,
      }),
      'IDEMPOTENCY_KEY_REUSED',
    );
    await expectCode(
      recovery.gameSessions.startGame(
        fixture.guest,
        RoomIdForTest(fixture.roomId),
        startRequest(fixture, 3),
      ),
      'FORBIDDEN',
    );
  });

  it('recovers exact requests after pending-insert and prepared-write crashes without visible intermediate starts', async () => {
    for (const crashPoint of ['pending', 'prepared'] as const) {
      const fixture = await seedGameFixture(databaseState.database);
      const base = new MongoGameSessionRepository(databaseState.database);
      let armed = true;
      const sessions: GameSessionRepository = new Proxy(base, {
        get(target, property, receiver) {
          if (property === 'insertPendingStart' && crashPoint === 'pending') {
            return async (session: Parameters<GameSessionRepository['insertPendingStart']>[0]) => {
              await target.insertPendingStart(session);
              if (armed) throw new Error('crash-pending');
            };
          }
          if (property === 'prepareStart' && crashPoint === 'prepared') {
            return async (...args: Parameters<GameSessionRepository['prepareStart']>) => {
              const result = await target.prepareStart(...args);
              if (armed) throw new Error('crash-prepared');
              return result;
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const crashed = await createHarness(databaseState.database, fixture, { sessions });
      const invoke = () =>
        crashed.gameSessions.startGame(
          fixture.host,
          RoomIdForTest(fixture.roomId),
          startRequest(fixture),
        );
      await expect(invoke()).rejects.toThrow(
        crashPoint === 'pending' ? 'crash-pending' : 'crash-prepared',
      );
      armed = false;
      const rawBefore = await databaseState.database
        .collection('gameSessions')
        .findOne({ roomId: fixture.roomId });
      expect(rawBefore?.['startIntent']?.['status']).toBe(crashPoint);
      expect(rawBefore?.['actionReceipts']).toHaveLength(0);
      expect(crashed.publisher.publications).toHaveLength(0);
      const rawRoom = await databaseState.database
        .collection('rooms')
        .findOne({ _id: fixture.roomId });
      expect(rawRoom?.['activeSessionId']).toBeNull();
      const recovered = await invoke();
      expect(recovered.data.version).toBe(1);
      expect(crashed.publisher.publications).toHaveLength(1);
      expect((await base.findByRoomId(fixture.roomId))?.actionReceipts).toHaveLength(1);
    }
  });
});
