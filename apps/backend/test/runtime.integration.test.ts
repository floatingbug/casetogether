import { once } from 'node:events';
import { parseSetCookie } from 'cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoDatabase } from '../src/database/mongodb.js';
import { ALLOWED_ORIGIN, createAuthTestApp, registrationPayload } from './support/auth-test-app.js';
import { startMongoTestDatabase, type MongoTestDatabase } from './support/mongo-test-database.js';

let mongo: MongoTestDatabase;

beforeAll(async () => {
  mongo = await startMongoTestDatabase();
});

afterAll(async () => {
  await mongo.close();
});

describe('real HTTP and mongod auth smoke', () => {
  it('serves readiness and a complete cookie register/me/logout flow', async () => {
    const readinessConnection = new MongoDatabase(
      mongo.mongod.getUri('casetogether_t003_test'),
      'casetogether_t003_test',
    );
    await readinessConnection.connect();
    const { app } = await createAuthTestApp({
      database: mongo.database,
      mongoDbStatus: () => readinessConnection.ping(),
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe('string');
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP test server');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const health = await fetch(`${baseUrl}/api/v1/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ data: { status: 'ok' } });

      const ready = await fetch(`${baseUrl}/api/v1/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({
        data: { status: 'ready', checks: { mongodb: 'up' } },
      });

      const registration = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(registrationPayload('runtime@example.com')),
      });
      expect(registration.status).toBe(201);
      await registration.arrayBuffer();
      const serializedCookie = registration.headers.get('set-cookie');
      expect(serializedCookie).not.toBeNull();
      if (serializedCookie === null) {
        throw new Error('Expected Set-Cookie from the runtime registration');
      }
      const cookie = parseSetCookie(serializedCookie);
      const cookieHeader = `ct_session=${cookie.value ?? ''}`;

      const me = await fetch(`${baseUrl}/api/v1/me`, { headers: { Cookie: cookieHeader } });
      expect(me.status).toBe(200);
      expect(await me.json()).toEqual({
        data: { id: expect.any(String), displayName: 'Detektivin' },
      });

      const logout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, Cookie: cookieHeader },
      });
      expect(logout.status).toBe(204);
      await logout.arrayBuffer();

      const afterLogout = await fetch(`${baseUrl}/api/v1/me`, {
        headers: { Cookie: cookieHeader },
      });
      expect(afterLogout.status).toBe(401);
      await afterLogout.arrayBuffer();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      await readinessConnection.close();
    }
  });
});
