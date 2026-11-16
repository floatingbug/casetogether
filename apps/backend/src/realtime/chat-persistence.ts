import { ChatContentSchema, ClientRequestIdSchema } from '@casetogether/shared';
import { MongoServerError, ObjectId, type Db } from 'mongodb';
import { z } from 'zod';

export const CHAT_SCHEMA_VERSION = 1;

export const ChatMessageDocumentSchema = z
  .object({
    _id: z.instanceof(ObjectId),
    schemaVersion: z.literal(CHAT_SCHEMA_VERSION),
    roomId: z.instanceof(ObjectId),
    senderUserId: z.instanceof(ObjectId),
    clientRequestId: ClientRequestIdSchema,
    content: ChatContentSchema,
    createdAt: z.date(),
    deleteAfter: z.date().nullable(),
  })
  .strict();

export type ChatMessageDocument = z.infer<typeof ChatMessageDocumentSchema>;

export class DuplicateChatMessageError extends Error {
  constructor() {
    super('The chat idempotency key already exists');
    this.name = 'DuplicateChatMessageError';
  }
}

export interface ChatRepository {
  findByIdempotencyKey(
    roomId: ObjectId,
    senderUserId: ObjectId,
    clientRequestId: string,
  ): Promise<ChatMessageDocument | null>;
  findRecent(roomId: ObjectId): Promise<ChatMessageDocument[]>;
  insert(message: ChatMessageDocument): Promise<void>;
}

export async function ensureChatIndexes(database: Db): Promise<void> {
  const messages = database.collection('messages');
  await messages.createIndex(
    { roomId: 1, senderUserId: 1, clientRequestId: 1 },
    { unique: true, name: 'messages_room_sender_request_unique' },
  );
  await messages.createIndex(
    { roomId: 1, createdAt: 1, _id: 1 },
    { name: 'messages_room_created_id' },
  );
  await messages.createIndex(
    { deleteAfter: 1 },
    { expireAfterSeconds: 0, name: 'messages_deleteAfter_ttl' },
  );
}

function parseMessage(document: unknown): ChatMessageDocument {
  return ChatMessageDocumentSchema.parse(document);
}

export class MongoChatRepository implements ChatRepository {
  private readonly collectionName = 'messages';
  private readonly database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  async findByIdempotencyKey(
    roomId: ObjectId,
    senderUserId: ObjectId,
    clientRequestId: string,
  ): Promise<ChatMessageDocument | null> {
    const document: unknown = await this.database.collection(this.collectionName).findOne({
      roomId,
      senderUserId,
      clientRequestId,
    });
    return document === null ? null : parseMessage(document);
  }

  async findRecent(roomId: ObjectId): Promise<ChatMessageDocument[]> {
    const documents: unknown[] = await this.database
      .collection(this.collectionName)
      .find({ roomId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(50)
      .toArray();
    return documents.map(parseMessage).reverse();
  }

  async insert(message: ChatMessageDocument): Promise<void> {
    try {
      await this.database.collection(this.collectionName).insertOne(message);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new DuplicateChatMessageError();
      }
      throw error;
    }
  }
}
