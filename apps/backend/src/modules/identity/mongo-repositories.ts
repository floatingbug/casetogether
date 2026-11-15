import { MongoServerError, type Collection, type Db, type ObjectId } from 'mongodb';
import {
  AuthSessionDocumentSchema,
  DuplicateEmailError,
  UserDocumentSchema,
  type AuthSessionDocument,
  type AuthSessionRepository,
  type UserDocument,
  type UserRepository,
} from './persistence.js';

function parseUserDocument(value: unknown): UserDocument {
  const result = UserDocumentSchema.safeParse(value);
  if (!result.success) {
    throw new Error('Invalid users persistence document');
  }
  return result.data;
}

function parseAuthSessionDocument(value: unknown): AuthSessionDocument {
  const result = AuthSessionDocumentSchema.safeParse(value);
  if (!result.success) {
    throw new Error('Invalid authSessions persistence document');
  }
  return result.data;
}

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

export class MongoUserRepository implements UserRepository {
  private readonly users: Collection;

  constructor(database: Db) {
    this.users = database.collection('users');
  }

  async findByEmailNormalized(emailNormalized: string): Promise<UserDocument | null> {
    const document: unknown = await this.users.findOne({ emailNormalized });
    return document === null ? null : parseUserDocument(document);
  }

  async findById(userId: ObjectId): Promise<UserDocument | null> {
    const document: unknown = await this.users.findOne({ _id: userId });
    return document === null ? null : parseUserDocument(document);
  }

  async insert(user: UserDocument): Promise<void> {
    try {
      await this.users.insertOne(user);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new DuplicateEmailError();
      }
      throw error;
    }
  }

  async updatePasswordHash(userId: ObjectId, passwordHash: string, updatedAt: Date): Promise<void> {
    const result = await this.users.updateOne(
      { _id: userId },
      { $set: { passwordHash, updatedAt } },
    );
    if (result.matchedCount !== 1) {
      throw new Error('User credential update did not match a user');
    }
  }
}

export class MongoAuthSessionRepository implements AuthSessionRepository {
  private readonly authSessions: Collection;

  constructor(database: Db) {
    this.authSessions = database.collection('authSessions');
  }

  async findBySessionIdHash(sessionIdHash: string): Promise<AuthSessionDocument | null> {
    const document: unknown = await this.authSessions.findOne({ sessionIdHash });
    return document === null ? null : parseAuthSessionDocument(document);
  }

  async insert(session: AuthSessionDocument): Promise<void> {
    await this.authSessions.insertOne(session);
  }

  async revoke(sessionIdHash: string, revokedAt: Date): Promise<void> {
    await this.authSessions.updateOne({ sessionIdHash, revokedAt: null }, { $set: { revokedAt } });
  }
}
