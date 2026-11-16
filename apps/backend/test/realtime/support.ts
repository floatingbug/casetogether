import { once } from 'node:events';
import { createServer, type Server as HttpServer } from 'node:http';
import type { Express } from 'express';
import type { Db } from 'mongodb';
import { io as connectSocketIo, type Socket } from 'socket.io-client';
import { createApp } from '../../src/app.js';
import { readBackendConfig } from '../../src/config.js';
import type { Clock } from '../../src/modules/identity/clock.js';
import {
  createGameSessionApplication,
  provisionDefaultCases,
} from '../../src/modules/game-sessions/index.js';
import type { GameSessionService } from '../../src/modules/game-sessions/game-session-service.js';
import {
  createIdentityService,
  type IdentityService,
} from '../../src/modules/identity/identity-service.js';
import type { InvitationCodeGenerator } from '../../src/modules/rooms/invitation.js';
import { createRoomService, type RoomService } from '../../src/modules/rooms/room-service.js';
import {
  createRealtimeApplication,
  type RealtimeApplication,
} from '../../src/realtime/application.js';
import { installHandshakeErrorAdapter } from '../../src/realtime/client-handshake.js';
import { RealtimeGateway } from '../../src/realtime/gateway.js';
import { ALLOWED_ORIGIN, TEST_SESSION_SECRET } from '../support/auth-test-app.js';
import { registerActor } from '../support/rooms-test-app.js';

export interface RealtimeTestWorldOptions {
  database: Db;
  clock?: Clock;
  invitationGenerator?: InvitationCodeGenerator;
  game?: boolean;
  logInternalError?: (requestId: string) => void;
}

export interface SocketOptions {
  transport?: 'websocket' | 'polling';
  cookie?: string;
  origin?: string;
  fetchSite?: string;
  omitOrigin?: boolean;
}

export class RealtimeTestWorld {
  readonly app: Express;
  readonly identityService: IdentityService;
  readonly roomService: RoomService;
  readonly application: RealtimeApplication;
  readonly gateway: RealtimeGateway;
  readonly server: HttpServer;
  readonly baseUrl: string;
  private readonly clients = new Set<Socket>();

  private constructor(options: {
    app: Express;
    identityService: IdentityService;
    roomService: RoomService;
    application: RealtimeApplication;
    gateway: RealtimeGateway;
    server: HttpServer;
    baseUrl: string;
  }) {
    this.app = options.app;
    this.identityService = options.identityService;
    this.roomService = options.roomService;
    this.application = options.application;
    this.gateway = options.gateway;
    this.server = options.server;
    this.baseUrl = options.baseUrl;
  }

  static async start(options: RealtimeTestWorldOptions): Promise<RealtimeTestWorld> {
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
    const application = await createRealtimeApplication({
      database: options.database,
      roomService,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const configuration = readBackendConfig({ NODE_ENV: 'test' });
    const gateway = new RealtimeGateway({
      application,
      identityService,
      cookieConfiguration: configuration.authCookie,
      allowedOrigins: [ALLOWED_ORIGIN],
      ...(options.logInternalError === undefined
        ? {}
        : { logInternalError: options.logInternalError }),
    });
    let gameSessionService: GameSessionService | undefined;
    if (options.game === true) {
      const gameApplication = await createGameSessionApplication({
        database: options.database,
        publicationPort: {
          publish: (publication) => gateway.publishGamePublication(publication),
        },
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
      gameSessionService = gameApplication.gameSessions;
      await provisionDefaultCases(options.database);
      gateway.configureGameServices({
        gameSessions: gameApplication.gameSessions,
        dialogue: gameApplication.dialogue,
      });
    }
    const app = createApp({
      allowedOrigins: [ALLOWED_ORIGIN],
      nodeEnv: 'test',
      identityService,
      roomService,
      ...(gameSessionService === undefined ? {} : { gameSessionService }),
      realtimeGateway: gateway,
      ...(options.logInternalError === undefined
        ? {}
        : { logInternalError: options.logInternalError }),
    });
    const server = createServer(app);
    gateway.attach(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP test server');
    }
    return new RealtimeTestWorld({
      app,
      identityService,
      roomService,
      application,
      gateway,
      server,
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
  }

  register(email: string, displayName: string) {
    return registerActor(this.app, email, displayName);
  }

  createClient(options: SocketOptions = {}): Socket {
    const extraHeaders: Record<string, string> = {};
    if (options.omitOrigin !== true) extraHeaders['Origin'] = options.origin ?? ALLOWED_ORIGIN;
    if (options.cookie !== undefined) extraHeaders['cookie'] = options.cookie;
    if (options.fetchSite !== undefined) extraHeaders['Sec-Fetch-Site'] = options.fetchSite;
    const client = connectSocketIo(this.baseUrl, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      timeout: 5_000,
      transports: [options.transport ?? 'websocket'],
      withCredentials: true,
      extraHeaders,
    });
    installHandshakeErrorAdapter(client);
    this.clients.add(client);
    return client;
  }

  async connect(options: SocketOptions = {}): Promise<Socket> {
    const client = this.createClient(options);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Socket connect timed out')), 5_000);
        client.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        client.once('connect_error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        client.connect();
      });
      return client;
    } catch (error) {
      client.close();
      this.clients.delete(client);
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.gateway.close();
    this.server.closeAllConnections();
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  }
}

export function emitAck(socket: Socket, event: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Ack timed out for ${event}`)), 5_000);
    socket.emit(event, payload, (response: unknown) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

export function nextEvent(socket: Socket, event: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Event timed out: ${event}`)), 5_000);
    socket.once(event, (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

export function recordEvents(socket: Socket, event: string): unknown[] {
  const events: unknown[] = [];
  socket.on(event, (payload: unknown) => events.push(payload));
  return events;
}

export async function expectConnectError(client: Socket): Promise<Error> {
  const errorPromise = new Promise<Error>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect_error timed out')), 5_000);
    client.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      resolve(error);
    });
    client.once('connect', () => {
      clearTimeout(timer);
      reject(new Error('Expected connect_error, received connect'));
    });
    client.connect();
  });
  return errorPromise;
}
