import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type request from 'supertest';
import type { Db, ObjectId } from 'mongodb';
import {
  RoomLeaveRequestSchema,
  RotateInvitationResponseEnvelopeSchema,
} from '@casetogether/shared';
import { MongoRoomRepository } from '../src/modules/rooms/mongo-room-repository.js';
import type { RoomDocument } from '../src/modules/rooms/persistence.js';
import type { ReceiptMatch, ReceiptSearch } from '../src/modules/rooms/repository.js';
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

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: () => settle?.(),
  };
}

/**
 * Deterministic interleaving for identical room mutations.
 *
 * Both requests must finish their entry receipt lookup before the first room read is
 * delegated. The second room read then blocks until the first request has committed
 * and answered. No sleeps, retries or weakened assertions are involved.
 */
class RoomReadGate {
  private armed = false;
  private receiptLookups = 0;
  private visibleReads = 0;
  private entryReceiptsSeen = deferred();
  private secondReadReached = deferred();
  private secondReadReleased = deferred();

  arm(): void {
    this.armed = true;
    this.receiptLookups = 0;
    this.visibleReads = 0;
    this.entryReceiptsSeen = deferred();
    this.secondReadReached = deferred();
    this.secondReadReleased = deferred();
  }

  beginReceiptLookup(): number {
    if (!this.armed) {
      return 0;
    }
    this.receiptLookups += 1;
    return this.receiptLookups;
  }

  finishReceiptLookup(sequence: number, match: ReceiptMatch | null): void {
    if (sequence >= 2 && match === null) {
      this.entryReceiptsSeen.resolve();
    }
  }

  async beforeVisibleRead(): Promise<void> {
    if (!this.armed) {
      return;
    }
    this.visibleReads += 1;
    if (this.visibleReads === 1) {
      await this.entryReceiptsSeen.promise;
      return;
    }
    if (this.visibleReads === 2) {
      this.secondReadReached.resolve();
      await this.secondReadReleased.promise;
    }
  }

  waitForSecondRead(): Promise<void> {
    return this.secondReadReached.promise;
  }

  releaseSecondRead(): void {
    this.secondReadReleased.resolve();
  }
}

class GatedRoomRepository extends MongoRoomRepository {
  private readonly gate: RoomReadGate;

  constructor(database: Db, gate: RoomReadGate) {
    super(database);
    this.gate = gate;
  }

  override async findReceipt(search: ReceiptSearch): Promise<ReceiptMatch | null> {
    const sequence = this.gate.beginReceiptLookup();
    const match = await super.findReceipt(search);
    this.gate.finishReceiptLookup(sequence, match);
    return match;
  }

  override async findVisibleById(
    roomId: ObjectId,
    actorUserId: ObjectId,
  ): Promise<RoomDocument | null> {
    await this.gate.beforeVisibleRead();
    return super.findVisibleById(roomId, actorUserId);
  }
}

describe('deterministic room read races', () => {
  it('resolves the losing identical rotation through the exact secret receipt', async () => {
    const gate = new RoomReadGate();
    const repository = new GatedRoomRepository(mongo.database, gate);
    const world = await createRoomsTestApp({
      database: mongo.database,
      repository,
      invitationGenerator: invitationSequence(TEST_CODE_1, TEST_CODE_2),
    });
    const host = await registerActor(world.app, 'gate-rotate-host@example.test', 'Host');
    const created = await postAs(world.app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);
    const roomId = created.body.data.room.id;
    const body = { clientRequestId: requestId(), expectedVersion: 1 };

    gate.arm();
    const first = postAs(world.app, `/api/v1/rooms/${roomId}/invitation/rotate`, host.cookie)
      .send(body)
      .then((response) => response);
    const second = postAs(world.app, `/api/v1/rooms/${roomId}/invitation/rotate`, host.cookie)
      .send(body)
      .then((response) => response);

    await gate.waitForSecondRead();
    const winner = await Promise.race([first, second]);
    gate.releaseSecondRead();
    const responses: request.Response[] = await Promise.all([first, second]);

    expect(winner.status).toBe(200);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(
      responses
        .map((response) => RotateInvitationResponseEnvelopeSchema.parse(response.body).data.outcome)
        .sort(),
    ).toEqual(['replayed', 'rotated']);
    const raw = await mongo.database.collection('rooms').findOne({});
    expect(raw?.['version']).toBe(2);
    expect(
      raw?.['actionReceipts'].filter(
        (receipt: { operation: string }) => receipt.operation === 'rotate',
      ),
    ).toHaveLength(1);
  });

  it('replays the persisted leave acknowledgement to the losing identical leave', async () => {
    const gate = new RoomReadGate();
    const repository = new GatedRoomRepository(mongo.database, gate);
    const world = await createRoomsTestApp({
      database: mongo.database,
      repository,
      invitationGenerator: invitationSequence(TEST_CODE_1),
    });
    const host = await registerActor(world.app, 'gate-leave-host@example.test', 'Host');
    const created = await postAs(world.app, '/api/v1/rooms', host.cookie)
      .send({ clientRequestId: requestId() })
      .expect(201);
    const roomId = created.body.data.room.id;
    const leave = RoomLeaveRequestSchema.parse({
      roomId,
      clientRequestId: requestId(),
      expectedVersion: 1,
    });

    gate.arm();
    const leaveOnce = () =>
      world.roomService
        .leaveRoom(host.user, leave)
        .then((result) => ({ status: 'left' as const, result }))
        .catch((error: unknown) => ({ status: 'error' as const, error }));
    const first = leaveOnce();
    const second = leaveOnce();

    await gate.waitForSecondRead();
    const winner = await Promise.race([first, second]);
    gate.releaseSecondRead();
    const outcomes = await Promise.all([first, second]);

    expect(winner.status).toBe('left');
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['left', 'left']);
    const results = outcomes.map((outcome) => {
      if (outcome.status !== 'left') {
        throw new Error(`Expected a leave result, received ${String(outcome.error)}`);
      }
      return outcome.result;
    });
    expect(results.map((result) => result.data)).toEqual([
      { roomId, roomVersion: 2, closed: true },
      { roomId, roomVersion: 2, closed: true },
    ]);
    const published = results.filter((result) => result.publication !== null);
    expect(published).toHaveLength(1);
    expect(published[0]?.publication?.event).toMatchObject({
      type: 'room.closed',
      roomId,
      version: 2,
    });
    const raw = await mongo.database.collection('rooms').findOne({});
    expect(raw).toMatchObject({ status: 'closed', version: 2 });
    expect(
      raw?.['actionReceipts'].filter(
        (receipt: { operation: string }) => receipt.operation === 'leave',
      ),
    ).toHaveLength(1);
  });
});
