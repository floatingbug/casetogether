import { MongoServerError, type Collection, type Db, type Document, type ObjectId } from 'mongodb';
import {
  RoomDocumentSchema,
  type ActionReceiptDocument,
  type RoomDocument,
} from './persistence.js';
import {
  DuplicateInvitationCodeError,
  DuplicateRoomReceiptError,
  type JoinMutationInput,
  type LeaveMutationInput,
  type ReceiptMatch,
  type ReceiptMutationInput,
  type ReceiptSearch,
  type RotateMutationInput,
  type RoomRepository,
} from './repository.js';

function parseRoomDocument(value: unknown): RoomDocument {
  const result = RoomDocumentSchema.safeParse(value);
  if (!result.success) {
    throw new Error('Invalid rooms persistence document');
  }
  return result.data;
}

function property(error: unknown, name: string): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  return Reflect.get(error, name);
}

function duplicateField(error: unknown): string | null {
  if (!(error instanceof MongoServerError) || error.code !== 11000) {
    return null;
  }
  const keyPattern = property(error, 'keyPattern');
  if (typeof keyPattern === 'object' && keyPattern !== null) {
    if (Reflect.has(keyPattern, 'invitation.codeHash')) {
      return 'invitation';
    }
    if (Reflect.has(keyPattern, 'actionReceipts.lookupKey')) {
      return 'receipt';
    }
  }
  if (error.message.includes('rooms_invitation_codeHash_unique')) {
    return 'invitation';
  }
  if (error.message.includes('rooms_actionReceipts_lookupKey_unique')) {
    return 'receipt';
  }
  return null;
}

function rethrowDuplicate(error: unknown): never {
  const duplicate = duplicateField(error);
  if (duplicate === 'invitation') {
    throw new DuplicateInvitationCodeError();
  }
  if (duplicate === 'receipt') {
    throw new DuplicateRoomReceiptError();
  }
  throw error;
}

function commonReceipt(
  input: ReceiptMutationInput & { roomId: ObjectId },
  operation: 'join' | 'rotate' | 'leave',
) {
  return {
    actorUserId: input.actorUserId,
    operation,
    aggregateId: input.roomId.toHexString(),
    clientRequestId: input.clientRequestId,
    payloadHash: input.payloadHash,
    lookupKey: input.lookupKey,
    createdAt: input.now,
  };
}

export class MongoRoomRepository implements RoomRepository {
  private readonly rooms: Collection;

  constructor(database: Db) {
    this.rooms = database.collection('rooms');
  }

  async insert(room: RoomDocument): Promise<void> {
    try {
      await this.rooms.insertOne(RoomDocumentSchema.parse(room));
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async findById(roomId: ObjectId): Promise<RoomDocument | null> {
    const document: unknown = await this.rooms.findOne({ _id: roomId });
    return document === null ? null : parseRoomDocument(document);
  }

  async findVisibleById(roomId: ObjectId, actorUserId: ObjectId): Promise<RoomDocument | null> {
    const document: unknown = await this.rooms.findOne({
      _id: roomId,
      'members.userId': actorUserId,
    });
    return document === null ? null : parseRoomDocument(document);
  }

  async findByInvitationCodeHash(codeHash: string): Promise<RoomDocument | null> {
    const document: unknown = await this.rooms.findOne({ 'invitation.codeHash': codeHash });
    return document === null ? null : parseRoomDocument(document);
  }

  async findReceipt(search: ReceiptSearch): Promise<ReceiptMatch | null> {
    const receiptPredicate: Document = {
      actorUserId: search.actorUserId,
      operation: search.operation,
      clientRequestId: search.clientRequestId,
    };
    if (search.aggregateId !== undefined) {
      receiptPredicate['aggregateId'] = search.aggregateId;
    }
    const document: unknown = await this.rooms.findOne({
      actionReceipts: { $elemMatch: receiptPredicate },
    });
    if (document === null) {
      return null;
    }
    const room = parseRoomDocument(document);
    const receipt = room.actionReceipts.find(
      (candidate) =>
        candidate.actorUserId.equals(search.actorUserId) &&
        candidate.operation === search.operation &&
        candidate.clientRequestId === search.clientRequestId &&
        (search.aggregateId === undefined || candidate.aggregateId === search.aggregateId),
    );
    if (receipt === undefined) {
      throw new Error('Room receipt lookup returned an inconsistent document');
    }
    return { room, receipt };
  }

  async appendNoopJoinReceipt(input: JoinMutationInput): Promise<RoomDocument | null> {
    const receipt = {
      ...commonReceipt(input, 'join'),
      result: {
        roomId: input.roomId,
        roomVersion: '$version',
        eventId: null,
        closed: null,
      },
    };
    try {
      const document: unknown = await this.rooms.findOneAndUpdate(
        {
          _id: input.roomId,
          'invitation.codeHash': input.codeHash,
          expiresAt: { $gt: input.now },
          status: { $in: ['waiting', 'ready'] },
          'members.userId': input.actorUserId,
          'actionReceipts.lookupKey': { $ne: input.lookupKey },
        },
        [
          {
            $set: {
              actionReceipts: { $concatArrays: ['$actionReceipts', [receipt]] },
              updatedAt: input.now,
            },
          },
        ],
        { returnDocument: 'after' },
      );
      return document === null ? null : parseRoomDocument(document);
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async appendNewJoin(input: JoinMutationInput): Promise<RoomDocument | null> {
    const receipt = {
      ...commonReceipt(input, 'join'),
      result: {
        roomId: input.roomId,
        roomVersion: { $add: ['$version', 1] },
        eventId: input.eventId,
        closed: null,
      },
    };
    const member = {
      userId: input.actorUserId,
      role: 'member',
      joinedAt: input.now,
    };
    try {
      const document: unknown = await this.rooms.findOneAndUpdate(
        {
          _id: input.roomId,
          'invitation.codeHash': input.codeHash,
          'invitation.expiresAt': { $gt: input.now },
          expiresAt: { $gt: input.now },
          status: { $in: ['waiting', 'ready'] },
          'members.userId': { $ne: input.actorUserId },
          'actionReceipts.lookupKey': { $ne: input.lookupKey },
          $expr: { $lt: [{ $size: '$members' }, 4] },
        },
        [
          {
            $set: {
              members: { $concatArrays: ['$members', [member]] },
              actionReceipts: { $concatArrays: ['$actionReceipts', [receipt]] },
              status: {
                $cond: [{ $gte: [{ $add: [{ $size: '$members' }, 1] }, 2] }, 'ready', 'waiting'],
              },
              version: { $add: ['$version', 1] },
              updatedAt: input.now,
            },
          },
        ],
        { returnDocument: 'after' },
      );
      return document === null ? null : parseRoomDocument(document);
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async rotateInvitation(input: RotateMutationInput): Promise<RoomDocument | null> {
    const receipt = {
      ...commonReceipt(input, 'rotate'),
      result: {
        roomId: input.roomId,
        roomVersion: input.expectedVersion + 1,
        eventId: input.eventId,
        closed: null,
      },
    };
    try {
      const document: unknown = await this.rooms.findOneAndUpdate(
        {
          _id: input.roomId,
          version: input.expectedVersion,
          expiresAt: { $gt: input.now },
          status: { $in: ['waiting', 'ready'] },
          hostUserId: input.actorUserId,
          members: {
            $elemMatch: { userId: input.actorUserId, role: 'host' },
          },
          'actionReceipts.lookupKey': { $ne: input.lookupKey },
        },
        [
          {
            $set: {
              invitation: input.invitation,
              actionReceipts: { $concatArrays: ['$actionReceipts', [receipt]] },
              version: { $add: ['$version', 1] },
              updatedAt: input.now,
            },
          },
        ],
        { returnDocument: 'after' },
      );
      return document === null ? null : parseRoomDocument(document);
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async leaveLobby(input: LeaveMutationInput): Promise<RoomDocument | null> {
    const receipt = {
      ...commonReceipt(input, 'leave'),
      result: {
        roomId: input.roomId,
        roomVersion: input.expectedVersion + 1,
        eventId: input.eventId,
        closed: input.closeLobby,
      },
    };
    const commonFilter: Document = {
      _id: input.roomId,
      version: input.expectedVersion,
      expiresAt: { $gt: input.now },
      status: { $in: ['waiting', 'ready'] },
      'members.userId': input.actorUserId,
      'actionReceipts.lookupKey': { $ne: input.lookupKey },
    };

    try {
      if (input.closeLobby) {
        const document: unknown = await this.rooms.findOneAndUpdate(
          {
            ...commonFilter,
            hostUserId: input.actorUserId,
            members: {
              $elemMatch: { userId: input.actorUserId, role: 'host' },
            },
          },
          [
            {
              $set: {
                status: 'closed',
                actionReceipts: { $concatArrays: ['$actionReceipts', [receipt]] },
                version: { $add: ['$version', 1] },
                updatedAt: input.now,
              },
            },
          ],
          { returnDocument: 'after' },
        );
        return document === null ? null : parseRoomDocument(document);
      }

      const document: unknown = await this.rooms.findOneAndUpdate(
        {
          ...commonFilter,
          members: { $elemMatch: { userId: input.actorUserId, role: 'member' } },
        },
        [
          {
            $set: {
              members: {
                $filter: {
                  input: '$members',
                  as: 'member',
                  cond: { $ne: ['$$member.userId', input.actorUserId] },
                },
              },
              actionReceipts: { $concatArrays: ['$actionReceipts', [receipt]] },
              version: { $add: ['$version', 1] },
              updatedAt: input.now,
            },
          },
          {
            $set: {
              status: {
                $cond: [{ $eq: [{ $size: '$members' }, 1] }, 'waiting', 'ready'],
              },
            },
          },
        ],
        { returnDocument: 'after' },
      );
      return document === null ? null : parseRoomDocument(document);
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  static receiptByLookupKey(room: RoomDocument, lookupKey: string): ActionReceiptDocument {
    const receipt = room.actionReceipts.find((candidate) => candidate.lookupKey === lookupKey);
    if (receipt === undefined) {
      throw new Error('Committed room mutation omitted its receipt');
    }
    return receipt;
  }
}
