import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { glockenschlagIds } from '../../src/game-engine/index.js';
import {
  MongoGameSessionRepository,
  MongoGameSessionRoomRepository,
  StartIntentCleanup,
  START_INTENT_STALE_AFTER_MS,
  type GameSessionRepository,
  type GameSessionRoomRepository,
  type StartIntentCleanupFailure,
  type StartIntentCleanupLogger,
  type StartIntentCleanupResult,
} from '../../src/modules/game-sessions/index.js';
import { SUPERSEDED_START_INTENT_RETENTION_MS } from '../../src/modules/game-sessions/persistence.js';
import { RoomDocumentSchema } from '../../src/modules/rooms/persistence.js';
import { startMongoTestDatabase } from '../support/mongo-test-database.js';
import {
  RoomIdForTest,
  TEST_NOW,
  createHarness,
  seedGameFixture,
  startFixtureGame,
  startRequest,
  testRequestId,
  type GameFixture,
} from './support.js';

const databaseState = await startMongoTestDatabase();
afterAll(() => databaseState.close());

class RecordingCleanupLogger implements StartIntentCleanupLogger {
  readonly runs: StartIntentCleanupResult[] = [];
  readonly failures: StartIntentCleanupFailure[] = [];

  run(result: StartIntentCleanupResult): void {
    this.runs.push(result);
  }

  error(failure: StartIntentCleanupFailure): void {
    this.failures.push(failure);
  }
}

function createCleanup(
  database: Db,
  options: {
    sessions?: GameSessionRepository;
    rooms?: Pick<GameSessionRoomRepository, 'findById'>;
    batchLimit?: number;
  } = {},
): { cleanup: StartIntentCleanup; logger: RecordingCleanupLogger } {
  const logger = new RecordingCleanupLogger();
  const cleanup = new StartIntentCleanup({
    sessions: options.sessions ?? new MongoGameSessionRepository(database),
    rooms: options.rooms ?? new MongoGameSessionRoomRepository(database),
    clock: () => new Date(TEST_NOW),
    logger,
    ...(options.batchLimit === undefined ? {} : { batchLimit: options.batchLimit }),
  });
  return { cleanup, logger };
}

async function seedAdditionalReadyRoom(
  database: Db,
  fixture: GameFixture,
  codeSeed: string,
): Promise<ObjectId> {
  const now = new Date(TEST_NOW);
  const roomId = new ObjectId();
  await database.collection('rooms').insertOne(
    RoomDocumentSchema.parse({
      _id: roomId,
      schemaVersion: 1,
      status: 'ready',
      version: 1,
      hostUserId: fixture.hostId,
      members: [
        { userId: fixture.hostId, role: 'host', joinedAt: now },
        { userId: fixture.guestId, role: 'member', joinedAt: now },
      ],
      maxPlayers: 4,
      invitation: {
        codeHash: codeSeed.repeat(64).slice(0, 64),
        createdAt: now,
        expiresAt: new Date(TEST_NOW + 60 * 60 * 1000),
      },
      activeSessionId: null,
      actionReceipts: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(TEST_NOW + 24 * 60 * 60 * 1000),
      deleteAfter: new Date(TEST_NOW + 24 * 60 * 60 * 1000),
    }),
  );
  return roomId;
}

/**
 * Produces a real persisted start intent through the production start path, then simulates the
 * crash boundary that leaves it unlinked. The intent is aged afterwards so the cleanup sees a
 * stale record without having to fake persistence documents.
 */
async function createUnlinkedStart(
  database: Db,
  fixture: GameFixture,
  options: {
    roomId: ObjectId;
    status: 'pending' | 'prepared';
    createdAt: Date;
    sequence: number;
  },
) {
  const base = new MongoGameSessionRepository(database);
  let armed = true;
  const crashing: GameSessionRepository = new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'insertPendingStart') {
        return async (session: Parameters<GameSessionRepository['insertPendingStart']>[0]) => {
          await target.insertPendingStart(session);
          if (armed) {
            throw new Error('cleanup-fixture-crash');
          }
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const harness = await createHarness(database, fixture, { sessions: crashing });
  const request = startRequest(fixture, options.sequence);
  await expect(
    harness.gameSessions.startGame(fixture.host, RoomIdForTest(options.roomId), request),
  ).rejects.toThrow('cleanup-fixture-crash');
  armed = false;

  let session = await base.findByRoomId(options.roomId);
  if (session === null) {
    throw new Error('Expected a persisted start intent');
  }
  if (options.status === 'prepared') {
    const prepared = await base.prepareStart(
      session._id,
      request.clientRequestId,
      new Date(TEST_NOW),
    );
    if (prepared === null) {
      throw new Error('Expected a preparable start intent');
    }
    session = prepared;
  }
  await database
    .collection('gameSessions')
    .updateOne({ _id: session._id }, { $set: { 'startIntent.createdAt': options.createdAt } });
  const aged = await base.findById(session._id);
  if (aged === null) {
    throw new Error('Expected an aged start intent');
  }
  return aged;
}

describe('T011 stale start-intent cleanup with real MongoDB', () => {
  it.each(['pending', 'prepared'] as const)(
    'supersedes an old unlinked %s intent with the retention timestamps',
    async (status) => {
      const fixture = await seedGameFixture(databaseState.database);
      const createdAt = new Date(TEST_NOW - START_INTENT_STALE_AFTER_MS - 60_000);
      const session = await createUnlinkedStart(databaseState.database, fixture, {
        roomId: fixture.roomId,
        status,
        createdAt,
        sequence: 1,
      });
      const { cleanup } = createCleanup(databaseState.database);
      const runAt = new Date(TEST_NOW);

      const result = await cleanup.runOnce(runAt);

      expect(result).toEqual({
        scanned: 1,
        superseded: 1,
        restored: 0,
        skippedLinked: 0,
        skippedChanged: 0,
        failed: 0,
      });
      const stored = await new MongoGameSessionRepository(databaseState.database).findById(
        session._id,
      );
      expect(stored?.startIntent.status).toBe('superseded');
      expect(stored?.startIntent.supersededAt).toEqual(runAt);
      expect(stored?.updatedAt).toEqual(runAt);
      expect(stored?.deleteAfter).toEqual(
        new Date(runAt.getTime() + SUPERSEDED_START_INTENT_RETENTION_MS),
      );
      const room = await new MongoGameSessionRoomRepository(databaseState.database).findById(
        fixture.roomId,
      );
      expect(room?.activeSessionId).toBeNull();
    },
  );

  it('leaves fresh pending and prepared intents untouched', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const secondRoom = await seedAdditionalReadyRoom(databaseState.database, fixture, '1');
    const pending = await createUnlinkedStart(databaseState.database, fixture, {
      roomId: fixture.roomId,
      status: 'pending',
      createdAt: new Date(TEST_NOW - START_INTENT_STALE_AFTER_MS + 60_000),
      sequence: 1,
    });
    const prepared = await createUnlinkedStart(databaseState.database, fixture, {
      roomId: secondRoom,
      status: 'prepared',
      createdAt: new Date(TEST_NOW - 60_000),
      sequence: 2,
    });
    const { cleanup } = createCleanup(databaseState.database);

    const result = await cleanup.runOnce(new Date(TEST_NOW));

    expect(result.scanned).toBe(0);
    expect(result.superseded).toBe(0);
    const sessions = new MongoGameSessionRepository(databaseState.database);
    expect((await sessions.findById(pending._id))?.startIntent.status).toBe('pending');
    expect((await sessions.findById(prepared._id))?.startIntent.status).toBe('prepared');
    expect((await sessions.findById(pending._id))?.deleteAfter).toBeNull();
    expect((await sessions.findById(prepared._id))?.deleteAfter).toBeNull();
  });

  it('skips an old intent whose room already links to the session', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const baseRooms = new MongoGameSessionRoomRepository(databaseState.database);
    let armed = true;
    const rooms: GameSessionRoomRepository = new Proxy(baseRooms, {
      get(target, property, receiver) {
        if (property === 'linkPreparedSession') {
          return async (...args: Parameters<GameSessionRoomRepository['linkPreparedSession']>) => {
            const linked = await target.linkPreparedSession(...args);
            if (armed) {
              throw new Error('crash-after-room-link');
            }
            return linked;
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
    ).rejects.toThrow('crash-after-room-link');
    armed = false;

    const sessions = new MongoGameSessionRepository(databaseState.database);
    const session = await sessions.findByRoomId(fixture.roomId);
    if (session === null) {
      throw new Error('Expected a linked prepared session');
    }
    expect(session.startIntent.status).toBe('prepared');
    expect(session.actionReceipts).toHaveLength(0);
    await databaseState.database
      .collection('gameSessions')
      .updateOne(
        { _id: session._id },
        { $set: { 'startIntent.createdAt': new Date(TEST_NOW - START_INTENT_STALE_AFTER_MS * 2) } },
      );

    const { cleanup } = createCleanup(databaseState.database);
    const result = await cleanup.runOnce(new Date(TEST_NOW));

    expect(result).toMatchObject({ scanned: 1, skippedLinked: 1, superseded: 0, failed: 0 });
    const stored = await sessions.findById(session._id);
    expect(stored?.startIntent.status).toBe('prepared');
    expect(stored?.startIntent.supersededAt).toBeNull();
    expect(stored?.deleteAfter).toBeNull();
    expect((await baseRooms.findById(fixture.roomId))?.activeSessionId?.equals(session._id)).toBe(
      true,
    );
  });

  it('never touches an old intent that already has a successful room:start receipt', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const harness = await createHarness(databaseState.database, fixture);
    const started = await startFixtureGame(harness);
    const sessionId = new ObjectId(started.sessionId);
    await databaseState.database
      .collection('rooms')
      .updateOne({ _id: fixture.roomId }, { $set: { activeSessionId: null, status: 'ready' } });
    await databaseState.database
      .collection('gameSessions')
      .updateOne(
        { _id: sessionId },
        { $set: { 'startIntent.createdAt': new Date(TEST_NOW - START_INTENT_STALE_AFTER_MS * 2) } },
      );
    const sessions = new MongoGameSessionRepository(databaseState.database);
    const before = await sessions.findById(sessionId);

    const { cleanup } = createCleanup(databaseState.database);
    const result = await cleanup.runOnce(new Date(TEST_NOW));

    expect(result.scanned).toBe(0);
    const after = await sessions.findById(sessionId);
    expect(after).toEqual(before);
    expect(after?.startIntent.status).toBe('prepared');
    expect(
      after?.actionReceipts.filter((receipt) => receipt.operation === 'room:start'),
    ).toHaveLength(1);
    expect(after?.deleteAfter).toBeNull();
  });

  it('is idempotent across repeated cleanup runs', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const session = await createUnlinkedStart(databaseState.database, fixture, {
      roomId: fixture.roomId,
      status: 'pending',
      createdAt: new Date(TEST_NOW - START_INTENT_STALE_AFTER_MS - 60_000),
      sequence: 1,
    });
    const { cleanup } = createCleanup(databaseState.database);

    const first = await cleanup.runOnce(new Date(TEST_NOW));
    expect(first).toMatchObject({ scanned: 1, superseded: 1 });
    const sessions = new MongoGameSessionRepository(databaseState.database);
    const snapshot = await sessions.findById(session._id);

    const second = await cleanup.runOnce(new Date(TEST_NOW + 60_000));

    expect(second).toMatchObject({ scanned: 0, superseded: 0, restored: 0, failed: 0 });
    expect(await sessions.findById(session._id)).toEqual(snapshot);
  });

  it('processes bounded batches ordered by startIntent.createdAt', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const secondRoom = await seedAdditionalReadyRoom(databaseState.database, fixture, '1');
    const thirdRoom = await seedAdditionalReadyRoom(databaseState.database, fixture, '2');
    const oldest = await createUnlinkedStart(databaseState.database, fixture, {
      roomId: fixture.roomId,
      status: 'pending',
      createdAt: new Date(TEST_NOW - START_INTENT_STALE_AFTER_MS - 3 * 60_000),
      sequence: 1,
    });
    const middle = await createUnlinkedStart(databaseState.database, fixture, {
      roomId: secondRoom,
      status: 'pending',
      createdAt: new Date(TEST_NOW - START_INTENT_STALE_AFTER_MS - 2 * 60_000),
      sequence: 2,
    });
    const newest = await createUnlinkedStart(databaseState.database, fixture, {
      roomId: thirdRoom,
      status: 'pending',
      createdAt: new Date(TEST_NOW - START_INTENT_STALE_AFTER_MS - 60_000),
      sequence: 3,
    });
    const { cleanup } = createCleanup(databaseState.database, { batchLimit: 2 });
    const sessions = new MongoGameSessionRepository(databaseState.database);

    const firstBatch = await cleanup.runOnce(new Date(TEST_NOW));

    expect(firstBatch).toMatchObject({ scanned: 2, superseded: 2, failed: 0 });
    expect((await sessions.findById(oldest._id))?.startIntent.status).toBe('superseded');
    expect((await sessions.findById(middle._id))?.startIntent.status).toBe('superseded');
    expect((await sessions.findById(newest._id))?.startIntent.status).toBe('pending');

    const secondBatch = await cleanup.runOnce(new Date(TEST_NOW + 60_000));

    expect(secondBatch).toMatchObject({ scanned: 1, superseded: 1, failed: 0 });
    expect((await sessions.findById(newest._id))?.startIntent.status).toBe('superseded');
  });

  it('restores the previous intent when a room link appears around the supersede write', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const session = await createUnlinkedStart(databaseState.database, fixture, {
      roomId: fixture.roomId,
      status: 'prepared',
      createdAt: new Date(TEST_NOW - START_INTENT_STALE_AFTER_MS - 60_000),
      sequence: 1,
    });
    const base = new MongoGameSessionRepository(databaseState.database);
    const sessions: GameSessionRepository = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'supersedeStaleStartIntent') {
          return async (
            input: Parameters<GameSessionRepository['supersedeStaleStartIntent']>[0],
          ) => {
            const superseded = await target.supersedeStaleStartIntent(input);
            await databaseState.database.collection('rooms').updateOne(
              { _id: fixture.roomId },
              {
                $set: {
                  activeSessionId: input.sessionId,
                  status: 'in_progress',
                  updatedAt: new Date(TEST_NOW),
                },
              },
            );
            return superseded;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const { cleanup, logger } = createCleanup(databaseState.database, { sessions });

    const result = await cleanup.runOnce(new Date(TEST_NOW));

    expect(result).toMatchObject({
      scanned: 1,
      superseded: 1,
      restored: 1,
      skippedLinked: 0,
      failed: 0,
    });
    expect(logger.failures).toHaveLength(0);
    const stored = await base.findById(session._id);
    expect(stored?.startIntent.status).toBe('prepared');
    expect(stored?.startIntent.supersededAt).toBeNull();
    expect(stored?.updatedAt).toEqual(session.updatedAt);
    expect(stored?.deleteAfter).toEqual(session.deleteAfter);
    expect(stored?.deleteAfter).toBeNull();
    expect(
      (
        await new MongoGameSessionRoomRepository(databaseState.database).findById(fixture.roomId)
      )?.activeSessionId?.equals(session._id),
    ).toBe(true);
  });

  it('does not modify completed sessions or receipts and keeps the TTL index contract', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const harness = await createHarness(databaseState.database, fixture);
    const started = await startFixtureGame(harness);
    const sessionId = new ObjectId(started.sessionId);
    await harness.gameSessions.submitFinalSolution(fixture.guest, started.sessionId, {
      clientRequestId: testRequestId(20),
      expectedVersion: 1,
      suspectId: glockenschlagIds.suspects.miriam,
    });
    await databaseState.database
      .collection('gameSessions')
      .updateOne(
        { _id: sessionId },
        { $set: { 'startIntent.createdAt': new Date(TEST_NOW - START_INTENT_STALE_AFTER_MS * 2) } },
      );
    const sessions = new MongoGameSessionRepository(databaseState.database);
    const before = await sessions.findById(sessionId);
    if (before === null) {
      throw new Error('Expected a completed session');
    }
    expect(before.phase).toBe('completed');

    const { cleanup } = createCleanup(databaseState.database);
    const result = await cleanup.runOnce(new Date(TEST_NOW + 10 * 60_000));

    expect(result.scanned).toBe(0);
    const after = await sessions.findById(sessionId);
    expect(after).toEqual(before);
    expect(after?.actionReceipts.some((receipt) => receipt.operation === 'game:final')).toBe(true);
    expect(after?.actionReceipts.some((receipt) => receipt.operation === 'room:start')).toBe(true);
    expect(after?.deleteAfter).not.toBeNull();

    const indexes = await databaseState.database.collection('gameSessions').indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'gameSessions_deleteAfter_ttl',
          key: { deleteAfter: 1 },
          expireAfterSeconds: 0,
        }),
        expect.objectContaining({
          name: 'gameSessions_startIntent_recovery',
          key: { 'startIntent.status': 1, 'startIntent.createdAt': 1 },
        }),
      ]),
    );
  });
});
