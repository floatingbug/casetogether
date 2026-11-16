import { PublicUserSchema, type PublicUser } from '@casetogether/shared';
import type { Db, ObjectId } from 'mongodb';
import { UserDocumentSchema } from '../identity/persistence.js';

export interface RoomUserDirectory {
  findPublicUsers(userIds: readonly ObjectId[]): Promise<ReadonlyMap<string, PublicUser>>;
}

export class MongoRoomUserDirectory implements RoomUserDirectory {
  private readonly database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  async findPublicUsers(userIds: readonly ObjectId[]): Promise<ReadonlyMap<string, PublicUser>> {
    const uniqueIds = [
      ...new Map(userIds.map((userId) => [userId.toHexString(), userId])).values(),
    ];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const documents: unknown[] = await this.database
      .collection('users')
      .find({ _id: { $in: uniqueIds } })
      .toArray();
    const result = new Map<string, PublicUser>();
    for (const document of documents) {
      const parsed = UserDocumentSchema.safeParse(document);
      if (!parsed.success) {
        throw new Error('Invalid users persistence document for room projection');
      }
      const publicUser = PublicUserSchema.parse({
        id: parsed.data._id.toHexString(),
        displayName: parsed.data.displayName,
      });
      result.set(publicUser.id, publicUser);
    }
    return result;
  }
}
