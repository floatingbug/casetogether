import { randomBytes } from 'node:crypto';
import { hash as argon2Hash } from '@node-rs/argon2';
import { MongoClient } from 'mongodb';
import { parseSetCookie } from 'cookie';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserResponseSchema } from '@casetogether/shared';
import { createApp } from '../src/app.js';
import { readBackendConfig } from '../src/config.js';
import { AUTH_SESSION_TTL_MS, AUTH_SESSION_TTL_SECONDS } from '../src/modules/identity/clock.js';
import { createIdentityService } from '../src/modules/identity/identity-service.js';
import { SessionTokenService } from '../src/modules/identity/session-tokens.js';
import {
  ALLOWED_ORIGIN,
  createAuthTestApp,
  MutableClock,
  registrationPayload,
  sessionCookie,
  setCookieHeader,
  TEST_NOW,
  TEST_PASSWORD,
  TEST_SESSION_SECRET,
  unsafePost,
} from './support/auth-test-app.js';
import { startMongoTestDatabase, type MongoTestDatabase } from './support/mongo-test-database.js';

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

describe('registration against real MongoDB', () => {
  it('normalizes email/displayName, returns only PublicUser and sets a seven-day cookie', async () => {
    const clock = new MutableClock();
    const { app } = await createAuthTestApp({ database: mongo.database, clock: clock.read });
    const response = await unsafePost(app, '/api/v1/auth/register')
      .send({
        ...registrationPayload('  PERSON@Example.COM '),
        displayName: '  Cafe\u0301  ',
      })
      .expect(201);

    expect(UserResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.data).toEqual({
      id: response.body.data.id,
      displayName: 'Café',
    });
    expect(response.body.data.id).toMatch(/^[a-f0-9]{24}$/);
    expect(JSON.stringify(response.body)).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(response.body)).not.toContain('PERSON@Example.COM');

    const cookie = parseSetCookie(setCookieHeader(response));
    expect(cookie).toMatchObject({
      name: 'ct_session',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: AUTH_SESSION_TTL_SECONDS,
    });
    expect(cookie.secure).toBeUndefined();
    expect(cookie.expires?.toISOString()).toBe(
      new Date(TEST_NOW.getTime() + AUTH_SESSION_TTL_MS).toISOString(),
    );
    expect(await mongo.database.collection('users').findOne({})).toMatchObject({
      emailNormalized: 'person@example.com',
      displayName: 'Café',
    });
  });

  it('maps case/trim duplicate emails to EMAIL_ALREADY_REGISTERED without a second session', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database });
    await unsafePost(app, '/api/v1/auth/register')
      .send(registrationPayload('Person@Example.com'))
      .expect(201);

    const response = await unsafePost(app, '/api/v1/auth/register')
      .send(registrationPayload('  person@example.COM  '))
      .expect(409);

    expect(response.body.error).toEqual({
      code: 'EMAIL_ALREADY_REGISTERED',
      message: 'Email is already registered',
      requestId: response.body.error.requestId,
    });
    expect(JSON.stringify(response.body)).not.toContain('person@example');
    expect(await mongo.database.collection('users').countDocuments()).toBe(1);
    expect(await mongo.database.collection('authSessions').countDocuments()).toBe(1);
  });

  it('uses the real unique index when equivalent registrations race', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database });

    const responses = await Promise.all([
      unsafePost(app, '/api/v1/auth/register').send(registrationPayload('RACE@Example.com')),
      unsafePost(app, '/api/v1/auth/register').send(registrationPayload(' race@example.COM ')),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await mongo.database.collection('users').countDocuments()).toBe(1);
    expect(await mongo.database.collection('authSessions').countDocuments()).toBe(1);
  });

  it.each([
    [
      'short password',
      { ...registrationPayload('validation@example.com'), password: 'too-short' },
      'password',
    ],
    [
      'unknown authoritative field',
      { ...registrationPayload('validation@example.com'), role: 'host' },
      '',
    ],
    [
      'control character in displayName',
      { ...registrationPayload('validation@example.com'), displayName: 'bad\u0000name' },
      'displayName',
    ],
  ])('rejects %s without secret values in field errors', async (_name, body, expectedPath) => {
    const { app } = await createAuthTestApp({ database: mongo.database });
    const response = await unsafePost(app, '/api/v1/auth/register').send(body).expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.fieldErrors[0]).toEqual({
      path: expectedPath,
      code: response.body.error.details.fieldErrors[0].code,
    });
    expect(JSON.stringify(response.body)).not.toContain('too-short');
    expect(JSON.stringify(response.body)).not.toContain('validation@example.com');
    expect(await mongo.database.collection('users').countDocuments()).toBe(0);
  });

  it('normalizes I independently of process locale', async () => {
    const previousLocale = process.env['LC_ALL'];
    process.env['LC_ALL'] = 'tr_TR.UTF-8';
    try {
      const { app } = await createAuthTestApp({ database: mongo.database });
      await unsafePost(app, '/api/v1/auth/register')
        .send(registrationPayload('I@EXAMPLE.COM'))
        .expect(201);
      expect(await mongo.database.collection('users').findOne({})).toMatchObject({
        emailNormalized: 'i@example.com',
      });
    } finally {
      if (previousLocale === undefined) {
        delete process.env['LC_ALL'];
      } else {
        process.env['LC_ALL'] = previousLocale;
      }
    }
  });

  it('uses identical public failures for an unknown account and a wrong password', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database });
    await unsafePost(app, '/api/v1/auth/register')
      .send(registrationPayload('known@example.com'))
      .expect(201);

    const wrongPassword = await unsafePost(app, '/api/v1/auth/login')
      .send({ email: 'known@example.com', password: 'wrong-password' })
      .expect(401);
    const unknownAccount = await unsafePost(app, '/api/v1/auth/login')
      .send({ email: 'unknown@example.com', password: 'wrong-password' })
      .expect(401);

    expect({ ...wrongPassword.body.error, requestId: 'same' }).toEqual({
      ...unknownAccount.body.error,
      requestId: 'same',
    });
    expect(wrongPassword.body.error).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    });
    expect(JSON.stringify([wrongPassword.body, unknownAccount.body])).not.toContain(
      'known@example.com',
    );
    expect(JSON.stringify([wrongPassword.body, unknownAccount.body])).not.toContain('argon2');
  });

  it('logs in with normalized credentials and upgrades weaker Argon2 parameters', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database });
    const email = 'legacy@example.com';
    await unsafePost(app, '/api/v1/auth/register').send(registrationPayload(email)).expect(201);
    const legacyHash = await argon2Hash(TEST_PASSWORD, {
      memoryCost: 8_192,
      timeCost: 1,
      parallelism: 1,
      outputLen: 16,
      salt: randomBytes(16),
    });
    await mongo.database
      .collection('users')
      .updateOne({ emailNormalized: email }, { $set: { passwordHash: legacyHash } });

    const login = await unsafePost(app, '/api/v1/auth/login')
      .send({ email: ' LEGACY@EXAMPLE.COM ', password: TEST_PASSWORD })
      .expect(200);

    expect(UserResponseSchema.safeParse(login.body).success).toBe(true);
    expect(login.body.data.displayName).toBe('Detektivin');
    expect(sessionCookie(login)).toMatch(/^ct_session=/);
    const upgradedUser = await mongo.database
      .collection('users')
      .findOne({ emailNormalized: email });
    expect(upgradedUser?.['passwordHash']).not.toBe(legacyHash);
    expect(upgradedUser?.['passwordHash']).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await mongo.database.collection('authSessions').countDocuments()).toBe(2);
  });
});

describe('cookie authentication, revocation and expiry', () => {
  it('allows GET /me only with the valid persisted cookie', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database });
    const unauthenticated = await request(app).get('/api/v1/me').expect(401);
    expect(unauthenticated.body.error).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
      requestId: unauthenticated.body.error.requestId,
    });
    await request(app).get('/api/v1/me').set('Cookie', 'ct_session=malformed').expect(401);

    const registration = await unsafePost(app, '/api/v1/auth/register')
      .send(registrationPayload('me@example.com'))
      .expect(201);
    const me = await request(app)
      .get('/api/v1/me')
      .set('Cookie', sessionCookie(registration))
      .expect(200);

    expect(me.body).toEqual(registration.body);
    expect(me.body.data).not.toHaveProperty('email');
    expect(me.body.data).not.toHaveProperty('passwordHash');
  });

  it('rejects tampered HMAC and well-signed but unknown sessions', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database });
    const registration = await unsafePost(app, '/api/v1/auth/register')
      .send(registrationPayload('tamper@example.com'))
      .expect(201);
    const cookie = sessionCookie(registration);
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('A') ? 'B' : 'A'}`;
    const unknownSession = new SessionTokenService(TEST_SESSION_SECRET).create().cookieValue;

    await request(app).get('/api/v1/me').set('Cookie', tampered).expect(401);
    await request(app).get('/api/v1/me').set('Cookie', `ct_session=${unknownSession}`).expect(401);
  });

  it('revokes logout server-side, clears an equivalent cookie and remains idempotent', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database });
    const registration = await unsafePost(app, '/api/v1/auth/register')
      .send(registrationPayload('logout@example.com'))
      .expect(201);
    const cookie = sessionCookie(registration);

    const logout = await unsafePost(app, '/api/v1/auth/logout').set('Cookie', cookie).expect(204);
    expect(logout.text).toBe('');
    const cleared = parseSetCookie(setCookieHeader(logout));
    expect(cleared).toMatchObject({
      name: 'ct_session',
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    expect(cleared.expires?.toISOString()).toBe(new Date(0).toISOString());

    await unsafePost(app, '/api/v1/auth/logout').set('Cookie', cookie).expect(204);
    await request(app).get('/api/v1/me').set('Cookie', cookie).expect(401);
    expect(await mongo.database.collection('authSessions').findOne({})).toMatchObject({
      revokedAt: expect.any(Date),
    });
  });

  it('expires the session at exactly seven days even while its DB document remains', async () => {
    const clock = new MutableClock();
    const { app } = await createAuthTestApp({ database: mongo.database, clock: clock.read });
    const registration = await unsafePost(app, '/api/v1/auth/register')
      .send(registrationPayload('expiry@example.com'))
      .expect(201);
    const cookie = sessionCookie(registration);

    clock.advance(AUTH_SESSION_TTL_MS - 1);
    await request(app).get('/api/v1/me').set('Cookie', cookie).expect(200);
    clock.advance(1);
    await request(app).get('/api/v1/me').set('Cookie', cookie).expect(401);
    expect(await mongo.database.collection('authSessions').findOne({})).toMatchObject({
      revokedAt: null,
    });
  });

  it('uses Secure cross-site cookies for both issued and cleared cookies in production', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database, nodeEnv: 'production' });
    const registration = await unsafePost(app, '/api/v1/auth/register')
      .send(registrationPayload('secure@example.com'))
      .expect(201);
    const logout = await unsafePost(app, '/api/v1/auth/logout')
      .set('Cookie', sessionCookie(registration))
      .expect(204);

    expect(parseSetCookie(setCookieHeader(registration)).secure).toBe(true);
    expect(parseSetCookie(setCookieHeader(logout)).secure).toBe(true);
    expect(parseSetCookie(setCookieHeader(registration)).sameSite).toBe('none');
    expect(parseSetCookie(setCookieHeader(logout)).sameSite).toBe('none');
    expect(readBackendConfig({ NODE_ENV: 'production' }).authCookie.sameSite).toBe('none');
  });
});

describe('auth CSRF and payload boundaries', () => {
  it.each([
    ['missing origin', undefined, undefined, 'application/json'],
    ['untrusted origin', 'https://untrusted.example', undefined, 'application/json'],
    ['cross-site fetch metadata', ALLOWED_ORIGIN, 'cross-site', 'application/json'],
    ['non-JSON body', ALLOWED_ORIGIN, undefined, 'text/plain'],
  ])('rejects %s before account creation', async (_name, origin, fetchSite, contentType) => {
    const { app } = await createAuthTestApp({ database: mongo.database });
    let call = request(app).post('/api/v1/auth/register');
    if (origin !== undefined) {
      call = call.set('Origin', origin);
    }
    if (fetchSite !== undefined) {
      call = call.set('Sec-Fetch-Site', fetchSite);
    }
    call = call.set('Content-Type', contentType);
    const response = await call
      .send(contentType === 'application/json' ? registrationPayload('csrf@example.com') : '{}')
      .expect(403);

    expect(response.body.error.code).toBe('CSRF_REJECTED');
    if (origin === 'https://untrusted.example') {
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(await mongo.database.collection('users').countDocuments()).toBe(0);
  });

  it('rejects auth JSON above 16 KiB before validation or persistence', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database });
    const response = await unsafePost(app, '/api/v1/auth/register')
      .send({
        email: 'large@example.com',
        password: 'x'.repeat(17 * 1024),
        displayName: 'Large',
      })
      .expect(413);

    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(JSON.stringify(response.body)).not.toContain('large@example.com');
    expect(await mongo.database.collection('users').countDocuments()).toBe(0);
  });
});

describe('auth HTTP rate limits', () => {
  it('counts malformed JSON before parsing toward the IP request budget', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await unsafePost(app, '/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send('{not-json')
        .expect(400);
    }
    const limited = await unsafePost(app, '/api/v1/auth/login')
      .send({ email: 'after-malformed@example.com', password: 'irrelevant' })
      .expect(429);

    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.body.error.details.retryAfterSeconds).toBe(300);
  });

  it('returns Retry-After and retryAfterSeconds after ten login requests per IP', async () => {
    const clock = new MutableClock();
    const { app } = await createAuthTestApp({ database: mongo.database, clock: clock.read });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await unsafePost(app, '/api/v1/auth/login')
        .send({ email: `unknown-${attempt}@example.com`, password: 'wrong-password' })
        .expect(401);
    }
    const limited = await unsafePost(app, '/api/v1/auth/login')
      .send({ email: 'eleventh@example.com', password: 'wrong-password' })
      .expect(429);

    expect(limited.headers['retry-after']).toBe('300');
    expect(limited.body.error).toEqual({
      code: 'RATE_LIMITED',
      message: 'Too many authentication attempts',
      requestId: limited.body.error.requestId,
      details: { retryAfterSeconds: 300 },
    });
    expect(JSON.stringify(limited.body)).not.toContain('eleventh@example.com');
  });

  it('limits five failed attempts for a normalized account key independently of IP', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await unsafePost(app, '/api/v1/auth/login')
        .send({ email: 'Account@Example.com', password: `wrong-${attempt}` })
        .expect(401);
    }
    const limited = await unsafePost(app, '/api/v1/auth/login')
      .send({ email: ' account@example.COM ', password: 'wrong-again' })
      .expect(429);

    expect(limited.headers['retry-after']).toBe('900');
    expect(limited.body.error.details.retryAfterSeconds).toBe(900);
    expect(JSON.stringify(limited.body)).not.toContain('account@example');
  });

  it('applies the IP request limit to successful registrations as well', async () => {
    const { app } = await createAuthTestApp({ database: mongo.database });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await unsafePost(app, '/api/v1/auth/register')
        .send(registrationPayload(`person-${attempt}@example.com`))
        .expect(201);
    }
    const limited = await unsafePost(app, '/api/v1/auth/register')
      .send(registrationPayload('person-ten@example.com'))
      .expect(429);

    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(await mongo.database.collection('users').countDocuments()).toBe(10);
  });
});

describe('safe internal errors and logs', () => {
  it('logs and returns only a correlation ID after a database failure', async () => {
    const separateClient = new MongoClient(mongo.mongod.getUri('casetogether_t003_test'));
    await separateClient.connect();
    const database = separateClient.db('casetogether_t003_test');
    const identityService = await createIdentityService({
      database,
      sessionSecret: TEST_SESSION_SECRET,
    });
    const logRequestIds: string[] = [];
    const app = createApp({
      allowedOrigins: [ALLOWED_ORIGIN],
      nodeEnv: 'test',
      identityService,
      logInternalError: (requestId) => logRequestIds.push(requestId),
    });
    const registration = await unsafePost(app, '/api/v1/auth/register')
      .send(registrationPayload('internal@example.com'))
      .expect(201);
    const cookie = sessionCookie(registration);
    await separateClient.close();

    const response = await request(app).get('/api/v1/me').set('Cookie', cookie).expect(500);
    const serializedEvidence = JSON.stringify({ body: response.body, logRequestIds });

    expect(response.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: response.body.error.requestId,
    });
    expect(logRequestIds).toEqual([response.body.error.requestId]);
    expect(serializedEvidence).not.toContain(cookie);
    expect(serializedEvidence).not.toContain(TEST_PASSWORD);
    expect(serializedEvidence).not.toContain(TEST_SESSION_SECRET);
    expect(serializedEvidence).not.toContain('internal@example.com');
    expect(response.body.error.stack).toBeUndefined();
  });
});
