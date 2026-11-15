import type { Express } from 'express';
import type { Db } from 'mongodb';
import request from 'supertest';
import { parseSetCookie } from 'cookie';
import { createApp } from '../../src/app.js';
import type { NodeEnvironment } from '../../src/config.js';
import type { MongoDbStatus } from '../../src/database/mongodb.js';
import type { Clock } from '../../src/modules/identity/clock.js';
import {
  createIdentityService,
  type IdentityService,
} from '../../src/modules/identity/identity-service.js';

export const ALLOWED_ORIGIN = 'http://localhost:5173';
export const TEST_SESSION_SECRET = 'T003-only-not-a-production-secret-0123456789abcdef';
export const TEST_PASSWORD = '  correct horse battery staple  ';
export const TEST_NOW = new Date('2026-11-15T12:00:00.000Z');

export class MutableClock {
  private currentTimeMs: number;

  constructor(initialTime: Date = TEST_NOW) {
    this.currentTimeMs = initialTime.getTime();
  }

  readonly read: Clock = () => new Date(this.currentTimeMs);

  advance(milliseconds: number): void {
    this.currentTimeMs += milliseconds;
  }
}

export interface AuthTestApp {
  app: Express;
  identityService: IdentityService;
}

interface CreateAuthTestAppOptions {
  database: Db;
  clock?: Clock;
  nodeEnv?: NodeEnvironment;
  mongoDbStatus?: () => Promise<MongoDbStatus>;
  logInternalError?: (requestId: string) => void;
}

export async function createAuthTestApp(options: CreateAuthTestAppOptions): Promise<AuthTestApp> {
  const identityService = await createIdentityService({
    database: options.database,
    sessionSecret: TEST_SESSION_SECRET,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const appOptions = {
    allowedOrigins: [ALLOWED_ORIGIN],
    nodeEnv: options.nodeEnv ?? 'test',
    identityService,
    ...(options.mongoDbStatus === undefined ? {} : { mongoDbStatus: options.mongoDbStatus }),
    ...(options.logInternalError === undefined
      ? {}
      : { logInternalError: options.logInternalError }),
  };
  return { app: createApp(appOptions), identityService };
}

export function registrationPayload(email: string): {
  email: string;
  password: string;
  displayName: string;
} {
  return {
    email,
    password: TEST_PASSWORD,
    displayName: ' Detektivin ',
  };
}

export function setCookieHeader(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const serialized = Array.isArray(header) ? header[0] : header;
  if (typeof serialized !== 'string') {
    throw new Error('Expected one Set-Cookie header');
  }
  return serialized;
}

export function sessionCookie(response: request.Response): string {
  const cookie = parseSetCookie(setCookieHeader(response));
  if (cookie.name !== 'ct_session' || cookie.value === undefined || cookie.value === '') {
    throw new Error('Expected a non-empty ct_session cookie');
  }
  return `ct_session=${cookie.value}`;
}

export function unsafePost(application: Express, path: string): request.Test {
  return request(application).post(path).set('Origin', ALLOWED_ORIGIN);
}
