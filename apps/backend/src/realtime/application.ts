import {
  ChatMessageSchema,
  RoomIdSchema,
  RoomJoinAckDataSchema,
  type ChatMessage,
  type ChatSendRequest,
  type PublicUser,
  type RoomId,
  type RoomJoinAckData,
  type RoomLeaveAckData,
  type RoomLeaveRequest,
  type RoomPresenceEvent,
  type UserId,
} from '@casetogether/shared';
import { ObjectId, type Db } from 'mongodb';
import { ApplicationError } from '../application-error.js';
import { systemClock, type Clock } from '../modules/identity/clock.js';
import type { RoomActionResult, RoomService } from '../modules/rooms/room-service.js';
import { MongoRoomUserDirectory, type RoomUserDirectory } from '../modules/rooms/user-directory.js';
import {
  CHAT_SCHEMA_VERSION,
  ChatMessageDocumentSchema,
  DuplicateChatMessageError,
  MongoChatRepository,
  ensureChatIndexes,
  type ChatMessageDocument,
  type ChatRepository,
} from './chat-persistence.js';
import { ChatRateLimiter } from './chat-rate-limiter.js';
import { PresenceTracker, type PresenceUpdate } from './presence.js';

export interface RoomConnectionResult {
  data: RoomJoinAckData;
  presenceEvent: RoomPresenceEvent | null;
  evictedSocketIds: readonly string[];
}

export interface ChatSendResult {
  message: ChatMessage;
  publish: boolean;
  recipientUserIds: readonly UserId[];
}

class KeyedSerialExecutor {
  private readonly queues = new Map<string, Promise<unknown>>();

  async run<Data>(key: string, operation: () => Promise<Data>): Promise<Data> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === current) {
        this.queues.delete(key);
      }
    }
  }
}

function toObjectId(value: string, unauthenticated = false): ObjectId {
  if (ObjectId.isValid(value)) {
    const objectId = new ObjectId(value);
    if (objectId.toHexString() === value.toLowerCase()) {
      return objectId;
    }
  }
  throw new ApplicationError(
    unauthenticated ? 'UNAUTHENTICATED' : 'NOT_FOUND',
    unauthenticated ? 'Authentication required' : 'Resource not found',
  );
}

export class RealtimeApplication {
  private readonly roomService: RoomService;
  private readonly messages: ChatRepository;
  private readonly users: RoomUserDirectory;
  private readonly clock: Clock;
  private readonly rateLimiter: ChatRateLimiter;
  private readonly presence: PresenceTracker;
  private readonly executor = new KeyedSerialExecutor();

  constructor(dependencies: {
    roomService: RoomService;
    messages: ChatRepository;
    users: RoomUserDirectory;
    clock: Clock;
    rateLimiter: ChatRateLimiter;
    presence: PresenceTracker;
  }) {
    this.roomService = dependencies.roomService;
    this.messages = dependencies.messages;
    this.users = dependencies.users;
    this.clock = dependencies.clock;
    this.rateLimiter = dependencies.rateLimiter;
    this.presence = dependencies.presence;
  }

  async joinRoom(
    actor: PublicUser,
    roomId: RoomId,
    socketId: string,
  ): Promise<RoomConnectionResult> {
    return this.executor.run(roomId, async () => {
      const base = await this.roomService.getRoom(actor, roomId);
      const memberIds = base.room.members.map((member) => member.user.id);
      const recentMessages = await this.recentMessages(roomId);
      const membership = this.presence.synchronizeMembers(roomId, memberIds);
      const onlineEvent = this.presence.markOnline(roomId, socketId, actor.id);
      const presenceEvent = onlineEvent ?? membership.event;
      const presence = this.presence.snapshot(roomId);
      if (presence === null) {
        throw new Error('Authorized room presence is missing');
      }
      return {
        data: this.joinAck(base, recentMessages, presence.members),
        presenceEvent,
        evictedSocketIds: membership.evictedSocketIds,
      };
    });
  }

  async syncRoom(actor: PublicUser, roomId: RoomId): Promise<RoomConnectionResult> {
    return this.executor.run(roomId, async () => {
      const base = await this.roomService.getRoom(actor, roomId);
      const memberIds = base.room.members.map((member) => member.user.id);
      const recentMessages = await this.recentMessages(roomId);
      const membership = this.presence.synchronizeMembers(roomId, memberIds);
      const presence = this.presence.snapshot(roomId);
      if (presence === null) {
        throw new Error('Authorized room presence is missing');
      }
      return {
        data: this.joinAck(base, recentMessages, presence.members),
        presenceEvent: membership.event,
        evictedSocketIds: membership.evictedSocketIds,
      };
    });
  }

  async leaveRoom(
    actor: PublicUser,
    input: RoomLeaveRequest,
  ): Promise<RoomActionResult<RoomLeaveAckData>> {
    return this.executor.run(input.roomId, () => this.roomService.leaveRoom(actor, input));
  }

  async sendChat(actor: PublicUser, input: ChatSendRequest): Promise<ChatSendResult> {
    return this.executor.run(input.roomId, async () => {
      const room = await this.roomService.getRoom(actor, input.roomId);
      const actorUserId = toObjectId(actor.id, true);
      const roomId = toObjectId(input.roomId);
      const clientRequestId = input.clientRequestId.toLowerCase();
      const existing = await this.messages.findByIdempotencyKey(
        roomId,
        actorUserId,
        clientRequestId,
      );
      if (existing !== null) {
        return {
          message: await this.projectReplay(actorUserId, input, existing),
          publish: false,
          recipientUserIds: room.room.members.map((member) => member.user.id),
        };
      }

      this.rateLimiter.consume(actor.id, input.roomId);
      const message = ChatMessageDocumentSchema.parse({
        _id: new ObjectId(),
        schemaVersion: CHAT_SCHEMA_VERSION,
        roomId,
        senderUserId: actorUserId,
        clientRequestId,
        content: input.content,
        createdAt: this.clock(),
        deleteAfter: null,
      });

      try {
        await this.messages.insert(message);
      } catch (error) {
        if (!(error instanceof DuplicateChatMessageError)) {
          throw error;
        }
        const duplicate = await this.messages.findByIdempotencyKey(
          roomId,
          actorUserId,
          clientRequestId,
        );
        if (duplicate === null) {
          throw new Error('Duplicate chat receipt could not be reloaded');
        }
        return {
          message: await this.projectReplay(actorUserId, input, duplicate),
          publish: false,
          recipientUserIds: room.room.members.map((member) => member.user.id),
        };
      }

      const [projected] = await this.projectMessages([message]);
      if (projected === undefined) {
        throw new Error('Persisted chat projection is missing');
      }
      return {
        message: projected,
        publish: true,
        recipientUserIds: room.room.members.map((member) => member.user.id),
      };
    });
  }

  synchronizeMembers(roomId: RoomId, memberIds: readonly UserId[]): PresenceUpdate {
    return this.presence.synchronizeMembers(roomId, memberIds);
  }

  closePresence(roomId: RoomId): readonly string[] {
    return this.presence.removeRoom(roomId);
  }

  disconnectPresence(socketId: string): PresenceUpdate[] {
    return this.presence.disconnect(socketId);
  }

  private joinAck(
    base: Awaited<ReturnType<RoomService['getRoom']>>,
    recentMessages: ChatMessage[],
    presence: RoomJoinAckData['room']['presence'],
  ): RoomJoinAckData {
    return RoomJoinAckDataSchema.parse({
      room: { ...base, recentMessages, presence },
      game: null,
      serverTime: this.clock().toISOString(),
    });
  }

  private async recentMessages(roomIdInput: RoomId): Promise<ChatMessage[]> {
    const roomId = toObjectId(RoomIdSchema.parse(roomIdInput));
    return this.projectMessages(await this.messages.findRecent(roomId));
  }

  private async projectReplay(
    actorUserId: ObjectId,
    input: ChatSendRequest,
    existing: ChatMessageDocument,
  ): Promise<ChatMessage> {
    if (
      !existing.roomId.equals(toObjectId(input.roomId)) ||
      !existing.senderUserId.equals(actorUserId) ||
      existing.clientRequestId !== input.clientRequestId.toLowerCase() ||
      existing.content !== input.content
    ) {
      throw new ApplicationError(
        'IDEMPOTENCY_KEY_REUSED',
        'clientRequestId was reused with a different payload',
      );
    }
    const [message] = await this.projectMessages([existing]);
    if (message === undefined) {
      throw new Error('Chat replay projection is missing');
    }
    return message;
  }

  private async projectMessages(documents: readonly ChatMessageDocument[]): Promise<ChatMessage[]> {
    const users = await this.users.findPublicUsers(
      documents.map((message) => message.senderUserId),
    );
    return documents.map((message) => {
      const sender = users.get(message.senderUserId.toHexString());
      if (sender === undefined) {
        throw new Error('Chat projection could not resolve the sender');
      }
      return ChatMessageSchema.parse({
        id: message._id.toHexString(),
        roomId: message.roomId.toHexString(),
        sender,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      });
    });
  }
}

export async function createRealtimeApplication(options: {
  database: Db;
  roomService: RoomService;
  clock?: Clock;
}): Promise<RealtimeApplication> {
  await ensureChatIndexes(options.database);
  const clock = options.clock ?? systemClock;
  return new RealtimeApplication({
    roomService: options.roomService,
    messages: new MongoChatRepository(options.database),
    users: new MongoRoomUserDirectory(options.database),
    clock,
    rateLimiter: new ChatRateLimiter(clock),
    presence: new PresenceTracker(clock),
  });
}
