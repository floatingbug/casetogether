import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorResponseSchema, HandshakeErrorDataSchema } from '@casetogether/shared';
import { readHandshakeErrorData } from '../../src/realtime/client-handshake.js';
import { HANDSHAKE_ERROR_MESSAGE } from '../../src/realtime/handshake.js';
import { ALLOWED_ORIGIN, TEST_SESSION_SECRET } from '../support/auth-test-app.js';
import { startMongoTestDatabase, type MongoTestDatabase } from '../support/mongo-test-database.js';
import { expectConnectError, RealtimeTestWorld, type SocketOptions } from './support.js';

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
  await Promise.all([
    mongo.database.collection('rooms').deleteMany({}),
    mongo.database.collection('messages').deleteMany({}),
  ]);
});

afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function rawLongPoll(options: SocketOptions = {}): Promise<Response> {
  if (world === undefined) throw new Error('Test world is not running');
  const headers: Record<string, string> = {};
  if (options.omitOrigin !== true) headers['Origin'] = options.origin ?? ALLOWED_ORIGIN;
  if (options.cookie !== undefined) headers['Cookie'] = options.cookie;
  if (options.fetchSite !== undefined) headers['Sec-Fetch-Site'] = options.fetchSite;
  return fetch(`${world.baseUrl}/socket.io/?EIO=4&transport=polling&t=handshake-test`, {
    headers,
  });
}

async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return body;
}

async function assertRejectedHandshake(
  transport: 'websocket' | 'polling',
  options: SocketOptions,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  if (world === undefined) throw new Error('Test world is not running');
  const error = await expectConnectError(world.createClient({ ...options, transport }));
  const data = readHandshakeErrorData(error);
  expect(HandshakeErrorDataSchema.parse(data)).toEqual({
    error: {
      code,
      message,
      requestId: data.error.requestId,
    },
  });
  expect(HandshakeErrorDataSchema.parse(Reflect.get(error, 'data'))).toEqual(data);
  if (transport === 'websocket') {
    expect(error.message).toBe(HANDSHAKE_ERROR_MESSAGE);
  }

  const response = await rawLongPoll(options);
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  const body = ErrorResponseSchema.parse(await readJson(response));
  expect(body).toEqual({
    error: { code, message, requestId: body.error.requestId },
  });
  expect(body.error.requestId).not.toBe(data.error.requestId);
}

describe('Socket.IO cookie/origin handshake mappings', () => {
  beforeEach(async () => {
    world = await RealtimeTestWorld.start({ database: mongo.database });
  });

  it.each(['websocket', 'polling'] as const)(
    'maps a missing cookie for %s to exact UNAUTHENTICATED wire errors',
    async (transport) => {
      await assertRejectedHandshake(
        transport,
        {},
        401,
        'UNAUTHENTICATED',
        'Authentication required',
      );
    },
  );

  it.each(['websocket', 'polling'] as const)(
    'maps absent and untrusted origins for %s before cookie authentication',
    async (transport) => {
      const host = await world!.register('handshake-origin@example.test', 'Handshake host');
      for (const options of [
        { cookie: host.cookie, omitOrigin: true },
        { cookie: host.cookie, origin: 'https://untrusted.example' },
        { cookie: host.cookie, origin: 'https://untrusted.example', fetchSite: 'cross-site' },
      ]) {
        await assertRejectedHandshake(
          transport,
          options,
          403,
          'CSRF_REJECTED',
          'Origin or fetch metadata was rejected',
        );
      }
    },
  );

  it.each(['websocket', 'polling'] as const)(
    'maps unexpected identity failures for %s to safe INTERNAL_ERROR responses and correlation-only logs',
    async (transport) => {
      const requestIds: string[] = [];
      await world!.close();
      world = await RealtimeTestWorld.start({
        database: mongo.database,
        logInternalError: (requestId) => requestIds.push(requestId),
      });
      const host = await world.register('handshake-internal@example.test', 'Handshake host');
      world.identityService.authenticate = async () => {
        throw new Error(`private database text ${TEST_SESSION_SECRET}`);
      };

      await assertRejectedHandshake(
        transport,
        { cookie: host.cookie },
        500,
        'INTERNAL_ERROR',
        'Internal server error',
      );
      expect(requestIds).toHaveLength(2);
      expect(JSON.stringify(requestIds)).not.toContain(TEST_SESSION_SECRET);
      expect(JSON.stringify(requestIds)).not.toContain('private database text');
    },
  );

  it.each(['websocket', 'polling'] as const)(
    'accepts the same valid cookie and allowlisted origin for %s',
    async (transport) => {
      const host = await world!.register(`handshake-success-${transport}@example.test`, 'Host');
      const client = await world!.connect({ transport, cookie: host.cookie });
      expect(client.connected).toBe(true);
      client.close();
    },
  );

  it.each(['websocket', 'polling'] as const)(
    'accepts an allowlisted origin with cross-site fetch metadata for %s',
    async (transport) => {
      const host = await world!.register(`handshake-cross-site-${transport}@example.test`, 'Host');
      const client = await world!.connect({
        transport,
        cookie: host.cookie,
        fetchSite: 'cross-site',
      });
      expect(client.connected).toBe(true);
      client.close();
    },
  );
});
