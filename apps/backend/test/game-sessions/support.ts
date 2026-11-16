import { randomUUID } from 'node:crypto';
import {
  ClientRequestIdSchema,
  PublicUserSchema,
  type PublicUser,
  type StartGameRequest,
} from '@casetogether/shared';
import { ObjectId, type Db } from 'mongodb';
import type { DialogueProvider } from '../../src/ai/index.js';
import { ensureCaseIndexes } from '../../src/database/case-indexes.js';
import { ensureGameSessionIndexes } from '../../src/database/game-session-indexes.js';
import { STILLER_GLOCKENSCHLAG_CASE, glockenschlagIds } from '../../src/game-engine/index.js';
import { DialogueService } from '../../src/modules/dialogue/dialogue-service.js';
import type { Clock } from '../../src/modules/identity/clock.js';
import { GameSessionService } from '../../src/modules/game-sessions/game-session-service.js';
import {
  MongoCaseRepository,
  MongoGameSessionRepository,
  MongoGameSessionRoomRepository,
} from '../../src/modules/game-sessions/mongo-repositories.js';
import type {
  GamePublication,
  GamePublicationPort,
} from '../../src/modules/game-sessions/publication.js';
import type {
  CaseRepository,
  GameSessionRepository,
  GameSessionRoomRepository,
} from '../../src/modules/game-sessions/repository.js';
import { MongoRoomUserDirectory } from '../../src/modules/rooms/user-directory.js';
import { RoomDocumentSchema } from '../../src/modules/rooms/persistence.js';

export const TEST_NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

export function testRequestId(sequence: number): string {
  return ClientRequestIdSchema.parse(
    `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  );
}

export class RecordingPublicationPort implements GamePublicationPort {
  readonly publications: GamePublication[] = [];

  constructor(private readonly beforeRecord?: (publication: GamePublication) => Promise<void>) {}

  async publish(publication: GamePublication): Promise<void> {
    await this.beforeRecord?.(publication);
    this.publications.push(structuredClone(publication));
  }
}

export interface GameFixture {
  roomId: ObjectId;
  host: PublicUser;
  guest: PublicUser;
  third: PublicUser;
  fourth: PublicUser;
  outsider: PublicUser;
  memberIds: ObjectId[];
  hostId: ObjectId;
  guestId: ObjectId;
  outsiderId: ObjectId;
}

export async function seedGameFixture(database: Db, memberCount = 2): Promise<GameFixture> {
  await Promise.all(
    ['users', 'authSessions', 'rooms', 'gameSessions', 'cases', 'messages'].map((name) =>
      database.collection(name).deleteMany({}),
    ),
  );
  const now = new Date(TEST_NOW);
  const hostId = new ObjectId();
  const guestId = new ObjectId();
  const thirdId = new ObjectId();
  const fourthId = new ObjectId();
  const outsiderId = new ObjectId();
  const users = [
    { id: hostId, displayName: 'Host' },
    { id: guestId, displayName: 'Gast' },
    { id: thirdId, displayName: 'Dritte Person' },
    { id: fourthId, displayName: 'Vierte Person' },
    { id: outsiderId, displayName: 'Außenstehend' },
  ];
  await database.collection('users').insertMany(
    users.map((user, index) => ({
      _id: user.id,
      schemaVersion: 1,
      emailNormalized: `person-${index}@example.test`,
      passwordHash: 'local-test-hash-not-a-credential',
      displayName: user.displayName,
      createdAt: now,
      updatedAt: now,
    })),
  );
  const allMemberIds = [hostId, guestId, thirdId, fourthId];
  const memberIds = allMemberIds.slice(0, memberCount);
  const roomId = new ObjectId();
  const room = RoomDocumentSchema.parse({
    _id: roomId,
    schemaVersion: 1,
    status: memberCount >= 2 ? 'ready' : 'waiting',
    version: 1,
    hostUserId: hostId,
    members: memberIds.map((userId, index) => ({
      userId,
      role: index === 0 ? 'host' : 'member',
      joinedAt: new Date(TEST_NOW + index * 1000),
    })),
    maxPlayers: 4,
    invitation: {
      codeHash: 'a'.repeat(64),
      createdAt: now,
      expiresAt: new Date(TEST_NOW + 60 * 60 * 1000),
    },
    activeSessionId: null,
    actionReceipts: [],
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(TEST_NOW + 24 * 60 * 60 * 1000),
    deleteAfter: new Date(TEST_NOW + 24 * 60 * 60 * 1000),
  });
  await database.collection('rooms').insertOne(room);
  await database.collection('cases').insertOne({
    ...STILLER_GLOCKENSCHLAG_CASE,
    _id: new ObjectId(),
    slug: glockenschlagIds.caseId,
    createdAt: now,
    updatedAt: now,
  });
  const publicUser = (id: ObjectId, displayName: string) =>
    PublicUserSchema.parse({ id: id.toHexString(), displayName });
  return {
    roomId,
    host: publicUser(hostId, 'Host'),
    guest: publicUser(guestId, 'Gast'),
    third: publicUser(thirdId, 'Dritte Person'),
    fourth: publicUser(fourthId, 'Vierte Person'),
    outsider: publicUser(outsiderId, 'Außenstehend'),
    memberIds,
    hostId,
    guestId,
    outsiderId,
  };
}

export interface HarnessOptions {
  provider?: DialogueProvider | null;
  publicationPort?: RecordingPublicationPort;
  sessions?: GameSessionRepository;
  rooms?: GameSessionRoomRepository;
  cases?: CaseRepository;
  clock?: Clock;
}

export async function createHarness(
  database: Db,
  fixture: GameFixture,
  options: HarnessOptions = {},
) {
  await ensureCaseIndexes(database);
  await ensureGameSessionIndexes(database);
  let ticks = 0;
  const clock = options.clock ?? (() => new Date(TEST_NOW + ticks++ * 1000));
  const sessions = options.sessions ?? new MongoGameSessionRepository(database);
  const rooms = options.rooms ?? new MongoGameSessionRoomRepository(database);
  const cases = options.cases ?? new MongoCaseRepository(database);
  const publisher = options.publicationPort ?? new RecordingPublicationPort();
  const dependencies = { sessions, rooms, cases, clock, publicationPort: publisher };
  return {
    gameSessions: new GameSessionService({
      ...dependencies,
      users: new MongoRoomUserDirectory(database),
    }),
    dialogue: new DialogueService({
      ...dependencies,
      provider: options.provider ?? null,
    }),
    sessions,
    rooms,
    cases,
    publisher,
    fixture,
  };
}

export function startRequest(fixture: GameFixture, sequence = 1): StartGameRequest {
  return {
    clientRequestId: testRequestId(sequence),
    caseId: glockenschlagIds.caseId,
    expectedVersion: 1,
  };
}

export async function startFixtureGame(
  harness: Awaited<ReturnType<typeof createHarness>>,
  sequence = 1,
) {
  const result = await harness.gameSessions.startGame(
    harness.fixture.host,
    RoomIdForTest(harness.fixture.roomId),
    startRequest(harness.fixture, sequence),
  );
  return result.data;
}

export function RoomIdForTest(roomId: ObjectId) {
  return RoomIdSchemaForTest.parse(roomId.toHexString());
}

import { RoomIdSchema as RoomIdSchemaForTest } from '@casetogether/shared';

export function newUuid(): string {
  return randomUUID();
}
