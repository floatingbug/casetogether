import { randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import {
  ChatMessageEventSchema,
  ChatSendAckSchema,
  ClientRequestIdSchema,
  ChatSendRequestSchema,
  ErrorResponseSchema,
  GameEventSchema,
  RoomEventSchema,
  RoomJoinAckDataSchema,
  RoomJoinAckSchema,
  RoomJoinRequestSchema,
  RoomLeaveAckSchema,
  RoomLeaveRequestSchema,
  RoomSyncAckSchema,
  RoomSyncRequestSchema,
  SocketAckFailureSchema,
  SuspectQuestionAckSchema,
  SuspectQuestionRequestSchema,
  UserIdSchema,
  type PublicUser,
  type RoomId,
  type RoomJoinAckData,
  type RoomPresenceEvent,
  type UserId,
} from '@casetogether/shared';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { z, type ZodType } from 'zod';
import { ApplicationError } from '../application-error.js';
import type { AuthCookieConfig } from '../config.js';
import type { Db } from 'mongodb';
import type { IdentityService } from '../modules/identity/identity-service.js';
import type { RoomService } from '../modules/rooms/room-service.js';
import type { DialogueService } from '../modules/dialogue/dialogue-service.js';
import type { GameSessionService } from '../modules/game-sessions/game-session-service.js';
import {
  parseGamePublication,
  type GamePublication,
} from '../modules/game-sessions/publication.js';
import type { Clock } from '../modules/identity/clock.js';
import { createRealtimeApplication, type RealtimeApplication } from './application.js';
import {
  MAX_EVENT_PAYLOAD_BYTES,
  payloadSize,
  payloadTooLarge,
  toSocketFailure,
  type InternalErrorLogger,
} from './errors.js';
import { HandshakeAuthenticator, type HandshakeFailure } from './handshake.js';

export const SOCKET_PATH = '/socket.io';

const RoomPublicationSchema = z
  .object({
    recipientUserIds: z.array(UserIdSchema).min(1).max(4),
    event: RoomEventSchema,
  })
  .strict();

type RoomPublication = z.infer<typeof RoomPublicationSchema>;
type Acknowledgement = (response: unknown) => void;

interface ConnectionState {
  cookieValue: string;
  userId: UserId;
}

function roomChannel(roomId: RoomId): string {
  return `room:${roomId}`;
}

function isAcknowledgement(value: unknown): value is Acknowledgement {
  return typeof value === 'function';
}

function clientRequestIdOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const clientRequestId = ClientRequestIdSchema.safeParse(Reflect.get(value, 'clientRequestId'));
  return clientRequestId.success ? clientRequestId.data : undefined;
}

function roomEventName(type: RoomPublication['event']['type']): string {
  switch (type) {
    case 'room.member_joined':
      return 'room:member-joined';
    case 'room.member_left':
      return 'room:member-left';
    case 'room.closed':
      return 'room:closed';
    case 'room.invitation_rotated':
      return 'room:invitation-rotated';
    case 'room.started':
      return 'room:started';
  }
}

export class RealtimeGateway {
  private readonly application: RealtimeApplication;
  private readonly identityService: IdentityService;
  private readonly handshake: HandshakeAuthenticator;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly logInternalError: InternalErrorLogger;
  private readonly connections = new Map<string, ConnectionState>();
  private gameSessions: Pick<GameSessionService, 'getSession'> | undefined;
  private dialogue: Pick<DialogueService, 'askQuestion'> | undefined;
  private io: SocketIOServer | undefined;

  constructor(options: {
    application: RealtimeApplication;
    identityService: IdentityService;
    cookieConfiguration: AuthCookieConfig;
    allowedOrigins: readonly string[];
    logInternalError?: InternalErrorLogger;
  }) {
    this.application = options.application;
    this.identityService = options.identityService;
    this.allowedOrigins = new Set(options.allowedOrigins);
    this.logInternalError =
      options.logInternalError ??
      ((requestId) => {
        console.error(
          JSON.stringify({ event: 'socket_request_failed', code: 'INTERNAL_ERROR', requestId }),
        );
      });
    this.handshake = new HandshakeAuthenticator({
      identityService: options.identityService,
      cookieConfiguration: options.cookieConfiguration,
      allowedOrigins: options.allowedOrigins,
      logInternalError: this.logInternalError,
    });
  }

  configureGameServices(options: {
    gameSessions: Pick<GameSessionService, 'getSession'>;
    dialogue: Pick<DialogueService, 'askQuestion'>;
  }): void {
    if (this.gameSessions !== undefined || this.dialogue !== undefined || this.io !== undefined) {
      throw new Error('Game services must be configured before attaching realtime');
    }
    this.gameSessions = options.gameSessions;
    this.dialogue = options.dialogue;
  }

  attach(server: HttpServer): void {
    if (this.io !== undefined) {
      throw new Error('Realtime gateway is already attached');
    }
    const io = new SocketIOServer(server, {
      path: SOCKET_PATH,
      serveClient: false,
      cors: {
        credentials: true,
        methods: ['GET', 'POST'],
        origin: (origin, callback) => {
          callback(null, origin !== undefined && this.allowedOrigins.has(origin));
        },
      },
    });
    this.io = io;

    io.engine.use((request: IncomingMessage, response: ServerResponse, next: () => void) => {
      void this.handshake.handleEngineRequest(request, response, next).catch(() => {
        const failure = this.unexpectedHandshakeFailure();
        if (request.headers.upgrade?.toLowerCase() === 'websocket') {
          next();
          return;
        }
        response.writeHead(failure.status, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(failure.body));
      });
    });

    io.use((socket, next) => {
      void this.handshake
        .authenticate(socket.request)
        .then((result) => {
          if (!result.ok) {
            next(this.handshake.asConnectError(result));
            return;
          }
          this.connections.set(socket.id, {
            cookieValue: result.cookieValue,
            userId: result.user.id,
          });
          next();
        })
        .catch(() => {
          next(this.handshake.asConnectError(this.unexpectedHandshakeFailure()));
        });
    });

    io.on('connection', (socket) => {
      this.registerSocket(socket);
    });
  }

  async publishRoomPublication(input: unknown): Promise<void> {
    if (input === null) {
      return;
    }
    const publication = RoomPublicationSchema.parse(input);
    const { event } = publication;
    const membership = this.application.synchronizeMembers(
      event.roomId,
      publication.recipientUserIds,
    );
    await this.evictFromRoom(event.roomId, membership.evictedSocketIds);
    this.emitRoomEvent(publication);

    if (event.type === 'room.member_joined' || event.type === 'room.member_left') {
      this.emitPresence(membership.event);
    }
    if (event.type === 'room.closed') {
      const evictedSocketIds = this.application.closePresence(event.roomId);
      await this.evictFromRoom(event.roomId, evictedSocketIds);
    }
  }

  async publishGamePublication(input: GamePublication): Promise<void> {
    const publication = parseGamePublication(input);
    if (publication.kind === 'start') {
      await this.publishRoomPublication({
        recipientUserIds: publication.deliveries.map((delivery) => delivery.recipientUserId),
        event: publication.roomEvent,
      });
    }
    for (const delivery of publication.deliveries) {
      this.emitToRecipients(
        publication.roomId,
        [delivery.recipientUserId],
        'game:event',
        GameEventSchema.parse(delivery.event),
      );
    }
  }

  disconnectSession(cookieValue: string | undefined): void {
    if (cookieValue === undefined || this.io === undefined) {
      return;
    }
    for (const [socketId, state] of this.connections) {
      if (state.cookieValue === cookieValue) {
        this.io.sockets.sockets.get(socketId)?.disconnect(true);
      }
    }
  }

  close(): void {
    const io = this.io;
    if (io === undefined) {
      return;
    }
    for (const socket of io.sockets.sockets.values()) {
      socket.disconnect(true);
    }
    io.engine.close();
    this.connections.clear();
    this.io = undefined;
  }

  private registerSocket(socket: Socket): void {
    const state = this.connections.get(socket.id);
    if (state === undefined) {
      socket.disconnect(true);
      return;
    }

    socket.on('room:join', (...args: unknown[]) => {
      this.handleCommand(
        socket,
        RoomJoinRequestSchema,
        RoomJoinAckSchema,
        args,
        async (actor, input) => {
          const result = await this.application.joinRoom(actor, input.roomId, socket.id);
          await this.evictFromRoom(input.roomId, result.evictedSocketIds);
          await socket.join(roomChannel(input.roomId));
          this.emitPresence(result.presenceEvent);
          return this.withGameSnapshot(actor, result.data);
        },
      );
    });
    socket.on('room:sync', (...args: unknown[]) => {
      this.handleCommand(
        socket,
        RoomSyncRequestSchema,
        RoomSyncAckSchema,
        args,
        async (actor, input) => {
          const result = await this.application.syncRoom(actor, input.roomId);
          await this.evictFromRoom(input.roomId, result.evictedSocketIds);
          this.emitPresence(result.presenceEvent);
          return this.withGameSnapshot(actor, result.data);
        },
      );
    });
    socket.on('room:leave', (...args: unknown[]) => {
      this.handleCommand(
        socket,
        RoomLeaveRequestSchema,
        RoomLeaveAckSchema,
        args,
        async (actor, input) => {
          const result = await this.application.leaveRoom(actor, input);
          await this.publishRoomPublication(result.publication);
          return result.data;
        },
      );
    });
    socket.on('chat:send', (...args: unknown[]) => {
      this.handleCommand(
        socket,
        ChatSendRequestSchema,
        ChatSendAckSchema,
        args,
        async (actor, input) => {
          const result = await this.application.sendChat(actor, input);
          if (result.publish) {
            this.emitChatMessage(input.roomId, result.recipientUserIds, result.message);
          }
          return { message: result.message };
        },
      );
    });
    socket.on('suspect:question', (...args: unknown[]) => {
      this.handleCommand(
        socket,
        SuspectQuestionRequestSchema,
        SuspectQuestionAckSchema,
        args,
        async (actor, input) => {
          if (this.dialogue === undefined) {
            throw new Error('Dialogue service is not configured');
          }
          const result = await this.dialogue.askQuestion(actor, input);
          return result.data;
        },
      );
    });
    socket.onAny((event, ...args: unknown[]) => {
      if (
        ['room:join', 'room:sync', 'room:leave', 'chat:send', 'suspect:question'].includes(event)
      ) {
        return;
      }
      this.rejectUnknownEvent(socket, args);
    });
    socket.on('disconnect', () => {
      this.connections.delete(socket.id);
      for (const update of this.application.disconnectPresence(socket.id)) {
        this.emitPresence(update.event);
      }
    });
  }

  private handleCommand<Input>(
    socket: Socket,
    requestSchema: ZodType<Input>,
    ackSchema: ZodType,
    args: unknown[],
    execute: (actor: PublicUser, input: Input) => Promise<unknown>,
  ): void {
    void this.executeCommand(socket, requestSchema, ackSchema, args, execute).catch(() => {
      socket.disconnect(true);
    });
  }

  private async executeCommand<Input>(
    socket: Socket,
    requestSchema: ZodType<Input>,
    ackSchema: ZodType,
    args: unknown[],
    execute: (actor: PublicUser, input: Input) => Promise<unknown>,
  ): Promise<void> {
    const acknowledgement = args.at(-1);
    if (!isAcknowledgement(acknowledgement)) {
      socket.disconnect(true);
      return;
    }

    let clientRequestId: string | undefined;
    try {
      if (args.length !== 2 || payloadSize(args[0]) > MAX_EVENT_PAYLOAD_BYTES) {
        if (args.length === 2) {
          throw payloadTooLarge();
        }
        throw new ApplicationError('VALIDATION_ERROR', 'Request validation failed');
      }
      const actor = await this.authenticateCommand(socket);
      const parsed = requestSchema.safeParse(args[0]);
      if (!parsed.success) {
        throw parsed.error;
      }
      clientRequestId = clientRequestIdOf(parsed.data);
      const data = await execute(actor, parsed.data);
      acknowledgement(ackSchema.parse({ ok: true, data }));
    } catch (error) {
      clientRequestId ??= clientRequestIdOf(args[0]);
      const failure = toSocketFailure(error, clientRequestId, this.logInternalError);
      acknowledgement(ackSchema.parse(failure));
      if (error instanceof ApplicationError && error.code === 'UNAUTHENTICATED') {
        const state = this.connections.get(socket.id);
        this.disconnectSession(state?.cookieValue);
      }
    }
  }

  private rejectUnknownEvent(socket: Socket, args: unknown[]): void {
    const acknowledgement = args.at(-1);
    if (!isAcknowledgement(acknowledgement)) {
      socket.disconnect(true);
      return;
    }
    void this.authenticateCommand(socket)
      .then(() => {
        if (args.length !== 2 || payloadSize(args[0]) > MAX_EVENT_PAYLOAD_BYTES) {
          throw args.length === 2
            ? payloadTooLarge()
            : new ApplicationError('VALIDATION_ERROR', 'Request validation failed');
        }
        throw new ApplicationError('VALIDATION_ERROR', 'Unsupported socket event');
      })
      .catch((error: unknown) => {
        const failure = toSocketFailure(error, clientRequestIdOf(args[0]), this.logInternalError);
        acknowledgement(SocketAckFailureSchema.parse(failure));
        if (error instanceof ApplicationError && error.code === 'UNAUTHENTICATED') {
          this.disconnectSession(this.connections.get(socket.id)?.cookieValue);
        }
      });
  }

  private async withGameSnapshot(
    actor: PublicUser,
    data: RoomJoinAckData,
  ): Promise<RoomJoinAckData> {
    const sessionId = data.room.room.activeSessionId;
    if (sessionId === null) {
      return RoomJoinAckDataSchema.parse({ ...data, game: null });
    }
    if (this.gameSessions === undefined) {
      throw new Error('Game-session service is not configured');
    }
    const game = await this.gameSessions.getSession(actor, sessionId);
    return RoomJoinAckDataSchema.parse({ ...data, game });
  }

  private async authenticateCommand(socket: Socket): Promise<PublicUser> {
    const state = this.connections.get(socket.id);
    if (state === undefined) {
      throw new ApplicationError('UNAUTHENTICATED', 'Authentication required');
    }
    const authentication = await this.identityService.authenticate(state.cookieValue);
    state.userId = authentication.user.id;
    return authentication.user;
  }

  private emitRoomEvent(publication: RoomPublication): void {
    const event = RoomEventSchema.parse(publication.event);
    this.emitToRecipients(
      event.roomId,
      publication.recipientUserIds,
      roomEventName(event.type),
      event,
    );
  }

  private emitChatMessage(
    roomId: RoomId,
    recipientUserIds: readonly UserId[],
    message: unknown,
  ): void {
    this.emitToRecipients(
      roomId,
      recipientUserIds,
      'chat:message',
      ChatMessageEventSchema.parse({ message }),
    );
  }

  private emitPresence(event: RoomPresenceEvent | null): void {
    if (event === null) {
      return;
    }
    this.emitToRecipients(
      event.roomId,
      event.members.map((member) => member.userId),
      'room:presence',
      event,
    );
  }

  private emitToRecipients(
    roomId: RoomId,
    recipientUserIds: readonly UserId[],
    eventName: string,
    payload: unknown,
  ): void {
    const io = this.io;
    if (io === undefined) {
      return;
    }
    const recipients = new Set(recipientUserIds);
    const channel = roomChannel(roomId);
    for (const socket of io.sockets.sockets.values()) {
      const state = this.connections.get(socket.id);
      if (state !== undefined && recipients.has(state.userId) && socket.rooms.has(channel)) {
        socket.emit(eventName, payload);
      }
    }
  }

  private async evictFromRoom(roomId: RoomId, socketIds: readonly string[]): Promise<void> {
    const io = this.io;
    if (io === undefined) {
      return;
    }
    for (const socketId of socketIds) {
      await io.sockets.sockets.get(socketId)?.leave(roomChannel(roomId));
    }
  }

  private unexpectedHandshakeFailure(): HandshakeFailure {
    const requestId = randomUUID();
    this.logInternalError(requestId);
    return {
      ok: false,
      status: 500,
      body: ErrorResponseSchema.parse({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId },
      }),
    };
  }
}

export async function createRealtimeGateway(options: {
  database: Db;
  identityService: IdentityService;
  roomService: RoomService;
  cookieConfiguration: AuthCookieConfig;
  allowedOrigins: readonly string[];
  clock?: Clock;
  logInternalError?: InternalErrorLogger;
}): Promise<RealtimeGateway> {
  const application = await createRealtimeApplication({
    database: options.database,
    roomService: options.roomService,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return new RealtimeGateway({
    application,
    identityService: options.identityService,
    cookieConfiguration: options.cookieConfiguration,
    allowedOrigins: options.allowedOrigins,
    ...(options.logInternalError === undefined
      ? {}
      : { logInternalError: options.logInternalError }),
  });
}
