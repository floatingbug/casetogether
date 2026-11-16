import { afterAll, describe, expect, it } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { CaseListResponseSchema, GameResponseSchema } from '@casetogether/shared';
import { ObjectId } from 'mongodb';
import { ApplicationError } from '../../src/application-error.js';
import { readBackendConfig } from '../../src/config.js';
import { createGameSessionRoutes } from '../../src/http/game-sessions/game-session-routes.js';
import { createIdentityService } from '../../src/modules/identity/identity-service.js';
import { SessionTokenService } from '../../src/modules/identity/session-tokens.js';
import { glockenschlagIds } from '../../src/game-engine/index.js';
import type { PublicUser } from '@casetogether/shared';
import { TEST_SESSION_SECRET } from '../support/auth-test-app.js';
import { startMongoTestDatabase } from '../support/mongo-test-database.js';
import {
  createHarness,
  seedGameFixture,
  startRequest,
  testRequestId,
  type GameFixture,
} from './support.js';

const databaseState = await startMongoTestDatabase();
afterAll(() => databaseState.close());

async function testApplication(
  fixture: GameFixture,
): Promise<{ app: Express; cookieFor(user: PublicUser): Promise<string> }> {
  const identityService = await createIdentityService({
    database: databaseState.database,
    sessionSecret: TEST_SESSION_SECRET,
  });
  const harness = await createHarness(databaseState.database, fixture);
  const cookieConfiguration = readBackendConfig({ NODE_ENV: 'test' }).authCookie;
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createGameSessionRoutes(identityService, harness.gameSessions, cookieConfiguration),
  );
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ApplicationError) {
      const status =
        error.code === 'UNAUTHENTICATED' ? 401 : error.code === 'NOT_FOUND' ? 404 : 400;
      response.status(status).json({
        error: {
          code: error.code,
          message: error.message,
          requestId: '00000000-0000-4000-8000-000000000001',
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }
    response.status(500).json({ message: 'unexpected test error' });
  });
  const tokens = new SessionTokenService(TEST_SESSION_SECRET);
  return {
    app,
    cookieFor: async (user) => {
      const material = tokens.create();
      await databaseState.database.collection('authSessions').insertOne({
        _id: new ObjectId(),
        schemaVersion: 1,
        sessionIdHash: material.sessionIdHash,
        userId: new ObjectId(user.id),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        revokedAt: null,
      });
      return `ct_session=${material.cookieValue}`;
    },
  };
}

describe('T009 exported REST router factory', () => {
  it('serves cases, start, recipient snapshots and final responses through strict shared envelopes', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const { app, cookieFor } = await testApplication(fixture);
    const hostCookie = await cookieFor(fixture.host);
    const guestCookie = await cookieFor(fixture.guest);
    const outsiderCookie = await cookieFor(fixture.outsider);

    const cases = await request(app).get('/api/v1/cases').set('Cookie', hostCookie).expect(200);
    expect(CaseListResponseSchema.safeParse(cases.body).success).toBe(true);
    expect(JSON.stringify(cases.body)).not.toMatch(/referenceAnswer|truth|concealedFact/);
    const started = await request(app)
      .post(`/api/v1/rooms/${fixture.roomId.toHexString()}/start`)
      .set('Cookie', hostCookie)
      .send(startRequest(fixture))
      .expect(200);
    const startBody = GameResponseSchema.parse(started.body);
    const snapshot = await request(app)
      .get(`/api/v1/sessions/${startBody.data.sessionId}`)
      .set('Cookie', guestCookie)
      .expect(200);
    expect(GameResponseSchema.safeParse(snapshot.body).success).toBe(true);
    await request(app)
      .get(`/api/v1/sessions/${startBody.data.sessionId}`)
      .set('Cookie', outsiderCookie)
      .expect(404);
    const completed = await request(app)
      .post(`/api/v1/sessions/${startBody.data.sessionId}/final-submission`)
      .set('Cookie', guestCookie)
      .send({
        clientRequestId: testRequestId(1600),
        expectedVersion: 1,
        suspectId: glockenschlagIds.suspects.miriam,
      })
      .expect(200);
    expect(GameResponseSchema.parse(completed.body).data.phase).toBe('completed');
  });

  it('rejects unauthenticated cases and strict unknown start fields before mutation', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const { app, cookieFor } = await testApplication(fixture);
    await request(app).get('/api/v1/cases').expect(401);
    const hostCookie = await cookieFor(fixture.host);
    await request(app)
      .post(`/api/v1/rooms/${fixture.roomId.toHexString()}/start`)
      .set('Cookie', hostCookie)
      .send({ ...startRequest(fixture), answerSource: 'ai' })
      .expect(400);
    expect(await databaseState.database.collection('gameSessions').countDocuments()).toBe(0);
  });
});
