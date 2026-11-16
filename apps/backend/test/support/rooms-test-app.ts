import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Db } from 'mongodb';
import type request from 'supertest';
import { UserResponseSchema, type PublicUser } from '@casetogether/shared';
import { createApp } from '../../src/app.js';
import type { Clock } from '../../src/modules/identity/clock.js';
import {
  createIdentityService,
  type IdentityService,
} from '../../src/modules/identity/identity-service.js';
import type { InvitationCodeGenerator } from '../../src/modules/rooms/invitation.js';
import { createRoomService, type RoomService } from '../../src/modules/rooms/room-service.js';
import {
  ALLOWED_ORIGIN,
  registrationPayload,
  sessionCookie,
  TEST_SESSION_SECRET,
  unsafePost,
} from './auth-test-app.js';

export const TEST_CODE_1 = 'ABCD-EFGH-JKLM';
export const TEST_CODE_2 = 'NPRS-TUVW-2345';
export const TEST_CODE_3 = '6789-ABCD-EFGH';
export const TEST_CODE_4 = 'JKLM-NPQR-STUV';
export const TEST_CODE_5 = 'WXYZ-2345-6789';

export interface RoomsTestApp {
  app: Express;
  identityService: IdentityService;
  roomService: RoomService;
}

interface CreateRoomsTestAppOptions {
  database: Db;
  clock?: Clock;
  invitationGenerator?: InvitationCodeGenerator;
  logInternalError?: (requestId: string) => void;
}

export async function createRoomsTestApp(
  options: CreateRoomsTestAppOptions,
): Promise<RoomsTestApp> {
  const identityService = await createIdentityService({
    database: options.database,
    sessionSecret: TEST_SESSION_SECRET,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const roomService = await createRoomService({
    database: options.database,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.invitationGenerator === undefined
      ? {}
      : { invitationGenerator: options.invitationGenerator }),
  });
  const app = createApp({
    allowedOrigins: [ALLOWED_ORIGIN],
    nodeEnv: 'test',
    identityService,
    roomService,
    ...(options.logInternalError === undefined
      ? {}
      : { logInternalError: options.logInternalError }),
  });
  return { app, identityService, roomService };
}

export async function resetRoomsTestDatabase(database: Db): Promise<void> {
  await Promise.all([
    database.collection('users').deleteMany({}),
    database.collection('authSessions').deleteMany({}),
    database.collection('rooms').deleteMany({}),
  ]);
}

export interface ActorSession {
  user: PublicUser;
  cookie: string;
}

export async function registerActor(
  app: Express,
  email: string,
  displayName: string,
): Promise<ActorSession> {
  const response = await unsafePost(app, '/api/v1/auth/register')
    .send({ ...registrationPayload(email), displayName })
    .expect(201);
  return { user: UserResponseSchema.parse(response.body).data, cookie: sessionCookie(response) };
}

export function postAs(application: Express, path: string, cookie: string): request.Test {
  return unsafePost(application, path).set('Cookie', cookie);
}

export function requestId(): string {
  return randomUUID();
}

export function invitationSequence(...codes: readonly string[]): InvitationCodeGenerator {
  let index = 0;
  return () => {
    const code = codes[index] ?? codes[codes.length - 1];
    if (code === undefined) {
      throw new Error('Test invitation sequence must not be empty');
    }
    index += 1;
    return code;
  };
}
