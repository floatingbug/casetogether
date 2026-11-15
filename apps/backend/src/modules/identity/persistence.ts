import { DisplayNameSchema, EmailSchema } from '@casetogether/shared';
import { ObjectId } from 'mongodb';
import { z } from 'zod';

export const AUTH_SCHEMA_VERSION = 1;

export const UserDocumentSchema = z
  .object({
    _id: z.instanceof(ObjectId),
    schemaVersion: z.literal(AUTH_SCHEMA_VERSION),
    emailNormalized: EmailSchema,
    passwordHash: z.string().min(1).max(4096),
    displayName: DisplayNameSchema,
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export const AuthSessionDocumentSchema = z
  .object({
    _id: z.instanceof(ObjectId),
    schemaVersion: z.literal(AUTH_SCHEMA_VERSION),
    sessionIdHash: z.string().regex(/^[a-f0-9]{64}$/),
    userId: z.instanceof(ObjectId),
    createdAt: z.date(),
    expiresAt: z.date(),
    revokedAt: z.date().nullable(),
  })
  .strict();

export type UserDocument = z.infer<typeof UserDocumentSchema>;
export type AuthSessionDocument = z.infer<typeof AuthSessionDocumentSchema>;

export class DuplicateEmailError extends Error {
  constructor() {
    super('Normalized email already exists');
    this.name = 'DuplicateEmailError';
  }
}

export interface UserRepository {
  findByEmailNormalized(emailNormalized: string): Promise<UserDocument | null>;
  findById(userId: ObjectId): Promise<UserDocument | null>;
  insert(user: UserDocument): Promise<void>;
  updatePasswordHash(userId: ObjectId, passwordHash: string, updatedAt: Date): Promise<void>;
}

export interface AuthSessionRepository {
  findBySessionIdHash(sessionIdHash: string): Promise<AuthSessionDocument | null>;
  insert(session: AuthSessionDocument): Promise<void>;
  revoke(sessionIdHash: string, revokedAt: Date): Promise<void>;
}
