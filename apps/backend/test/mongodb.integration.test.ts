import request from 'supertest';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ensureAuthIndexes } from '../src/database/auth-indexes.js';
import { MongoDatabase } from '../src/database/mongodb.js';
import { AUTH_SCHEMA_VERSION, UserDocumentSchema } from '../src/modules/identity/persistence.js';
import {
  createAuthTestApp,
  registrationPayload,
  sessionCookie,
  TEST_PASSWORD,
  TEST_SESSION_SECRET,
  unsafePost,
} from './support/auth-test-app.js';
import { startMongoTestDatabase, TEST_MONGODB_VERSION } from './support/mongo-test-database.js';
import type { MongoTestDatabase } from './support/mongo-test-database.js';

let mongo: MongoTestDatabase;

beforeAll(async () => {
  mongo = await startMongoTestDatabase();
});

afterAll(async () => {
  await mongo.close();
});

beforeEach(async () => {
  await mongo.reset();
});

describe('real MongoDB auth persistence', () => {
  it('starts the documented mongod binary without any external cluster', () => {
    expect(mongo.binaryVersion).toBe(TEST_MONGODB_VERSION);
    expect(mongo.mongod.getUri()).toMatch(/^mongodb:\/\/127\.0\.0\.1:/);
  });

  it('creates all required auth indexes idempotently and no game collections', async () => {
    await ensureAuthIndexes(mongo.database);
    await ensureAuthIndexes(mongo.database);

    const userIndexes = await mongo.database.collection('users').indexes();
    const sessionIndexes = await mongo.database.collection('authSessions').indexes();
    expect(userIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'users_emailNormalized_unique',
          key: { emailNormalized: 1 },
          unique: true,
        }),
      ]),
    );
    expect(sessionIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'authSessions_sessionIdHash_unique',
          key: { sessionIdHash: 1 },
          unique: true,
        }),
        expect.objectContaining({
          name: 'authSessions_userId_revokedAt',
          key: { userId: 1, revokedAt: 1 },
        }),
        expect.objectContaining({
          name: 'authSessions_expiresAt_ttl',
          key: { expiresAt: 1 },
          expireAfterSeconds: 0,
        }),
      ]),
    );

    const collections = await mongo.database.listCollections({}, { nameOnly: true }).toArray();
    const collectionNames = collections.map((collection) => collection.name);
    expect(collectionNames).not.toContain('rooms');
    expect(collectionNames).not.toContain('gameSessions');
    expect(collectionNames).not.toContain('cases');
  });

  it('enforces normalized email uniqueness with a real MongoDB duplicate-key error', async () => {
    await ensureAuthIndexes(mongo.database);
    const now = new Date('2026-11-15T12:00:00.000Z');
    const first = UserDocumentSchema.parse({
      _id: new ObjectId(),
      schemaVersion: AUTH_SCHEMA_VERSION,
      emailNormalized: 'person@example.com',
      passwordHash: 'test-only-hash-not-from-a-password',
      displayName: 'Person',
      createdAt: now,
      updatedAt: now,
    });
    const duplicate = UserDocumentSchema.parse({
      ...first,
      _id: new ObjectId(),
    });
    const users = mongo.database.collection('users');
    await users.insertOne(first);

    let duplicateError: unknown;
    try {
      await users.insertOne(duplicate);
    } catch (error) {
      duplicateError = error;
    }

    expect(duplicateError).toMatchObject({ code: 11000 });
    expect(await users.countDocuments({ emailNormalized: 'person@example.com' })).toBe(1);
  });

  it('persists only a session ID hash and never raw cookie/password material', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database });
    const response = await unsafePost(app, '/api/v1/auth/register')
      .send(registrationPayload('session-inspection@example.com'))
      .expect(201);
    const cookie = sessionCookie(response);
    const rawSessionId = cookie.split('=')[1]?.split('.')[0];
    const rawSignature = cookie.split('.')[1];
    const sessionDocument = await mongo.database.collection('authSessions').findOne({});
    const userDocument = await mongo.database.collection('users').findOne({});
    const serializedSession = JSON.stringify(sessionDocument);
    const serializedUser = JSON.stringify(userDocument);

    expect(sessionDocument).toMatchObject({
      schemaVersion: 1,
      revokedAt: null,
    });
    expect(sessionDocument?.['sessionIdHash']).toMatch(/^[a-f0-9]{64}$/);
    expect(serializedSession).not.toContain(cookie);
    expect(rawSessionId).toBeDefined();
    if (rawSessionId !== undefined) {
      expect(serializedSession).not.toContain(rawSessionId);
    }
    expect(rawSignature).toBeDefined();
    if (rawSignature !== undefined) {
      expect(serializedSession).not.toContain(rawSignature);
    }
    expect(serializedSession).not.toContain(TEST_SESSION_SECRET);
    expect(serializedUser).not.toContain(TEST_PASSWORD);
    expect(userDocument?.['passwordHash']).toMatch(/^\$argon2id\$/);
    expect(userDocument?.['emailNormalized']).toBe('session-inspection@example.com');
    expect(response.body).not.toHaveProperty('data.emailNormalized');
    expect(response.body).not.toHaveProperty('data.passwordHash');
    expect(response.body).not.toHaveProperty('data.sessionIdHash');
  });
});

describe('real MongoDB readiness', () => {
  it('returns ready only after a successful ping and down after the client closes', async () => {
    const connection = new MongoDatabase(
      mongo.mongod.getUri('casetogether_t003_test'),
      'casetogether_t003_test',
    );
    await connection.connect();
    const app = createApp({
      nodeEnv: 'test',
      mongoDbStatus: () => connection.ping(),
    });

    await request(app)
      .get('/api/v1/ready')
      .expect(200, { data: { status: 'ready', checks: { mongodb: 'up' } } });
    await connection.close();

    await request(app)
      .get('/api/v1/ready')
      .expect(503, { data: { status: 'not_ready', checks: { mongodb: 'down' } } });
    await request(app)
      .get('/api/v1/health')
      .expect(200, { data: { status: 'ok' } });
  });
});
