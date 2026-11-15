import { randomBytes } from 'node:crypto';
import {
  PublicUserSchema,
  type LoginRequest,
  type PublicUser,
  type RegisterRequest,
} from '@casetogether/shared';
import { ObjectId, type Db } from 'mongodb';
import { ApplicationError } from '../../application-error.js';
import { ensureAuthIndexes } from '../../database/auth-indexes.js';
import { AUTH_SESSION_TTL_MS, systemClock, type Clock } from './clock.js';
import { MongoAuthSessionRepository, MongoUserRepository } from './mongo-repositories.js';
import { Argon2PasswordHasher, type PasswordHasher } from './password-hasher.js';
import {
  AUTH_SCHEMA_VERSION,
  AuthSessionDocumentSchema,
  DuplicateEmailError,
  UserDocumentSchema,
  type AuthSessionRepository,
  type UserDocument,
  type UserRepository,
} from './persistence.js';
import { AuthRateLimiter } from './rate-limiter.js';
import { SessionTokenService } from './session-tokens.js';

export interface IssuedAuthentication {
  user: PublicUser;
  cookieValue: string;
  expiresAt: Date;
}

export interface Authentication {
  user: PublicUser;
}

interface IdentityServiceDependencies {
  users: UserRepository;
  authSessions: AuthSessionRepository;
  passwordHasher: PasswordHasher;
  sessionTokens: SessionTokenService;
  rateLimiter: AuthRateLimiter;
  clock: Clock;
  dummyPasswordHash: string;
}

function unauthenticated(): ApplicationError {
  return new ApplicationError('UNAUTHENTICATED', 'Authentication required');
}

function invalidCredentials(): ApplicationError {
  return new ApplicationError('INVALID_CREDENTIALS', 'Invalid email or password');
}

function duplicateEmail(): ApplicationError {
  return new ApplicationError('EMAIL_ALREADY_REGISTERED', 'Email is already registered');
}

function toPublicUser(user: UserDocument): PublicUser {
  return PublicUserSchema.parse({ id: user._id.toHexString(), displayName: user.displayName });
}

export class IdentityService {
  private readonly users: UserRepository;
  private readonly authSessions: AuthSessionRepository;
  private readonly passwordHasher: PasswordHasher;
  private readonly sessionTokens: SessionTokenService;
  private readonly rateLimiter: AuthRateLimiter;
  private readonly clock: Clock;
  private readonly dummyPasswordHash: string;

  constructor(dependencies: IdentityServiceDependencies) {
    this.users = dependencies.users;
    this.authSessions = dependencies.authSessions;
    this.passwordHasher = dependencies.passwordHasher;
    this.sessionTokens = dependencies.sessionTokens;
    this.rateLimiter = dependencies.rateLimiter;
    this.clock = dependencies.clock;
    this.dummyPasswordHash = dependencies.dummyPasswordHash;
  }

  async register(input: RegisterRequest): Promise<IssuedAuthentication> {
    const attempt = this.rateLimiter.beginAccount(input.email);
    let outcome: 'success' | 'failure' = 'success';

    try {
      const existing = await this.users.findByEmailNormalized(input.email);
      if (existing !== null) {
        outcome = 'failure';
        throw duplicateEmail();
      }

      const passwordHash = await this.passwordHasher.hash(input.password);
      const now = this.now();
      const user = UserDocumentSchema.parse({
        _id: new ObjectId(),
        schemaVersion: AUTH_SCHEMA_VERSION,
        emailNormalized: input.email,
        passwordHash,
        displayName: input.displayName,
        createdAt: now,
        updatedAt: now,
      });

      try {
        await this.users.insert(user);
      } catch (error) {
        if (error instanceof DuplicateEmailError) {
          outcome = 'failure';
          throw duplicateEmail();
        }
        throw error;
      }

      const session = await this.issueSession(user._id);
      return { user: toPublicUser(user), ...session };
    } finally {
      attempt.settle(outcome);
    }
  }

  async login(input: LoginRequest): Promise<IssuedAuthentication> {
    const attempt = this.rateLimiter.beginAccount(input.email);
    let outcome: 'success' | 'failure' = 'success';

    try {
      const user = await this.users.findByEmailNormalized(input.email);
      const candidateHash = user?.passwordHash ?? this.dummyPasswordHash;
      const validPassword = await this.passwordHasher.verify(candidateHash, input.password);
      if (user === null || !validPassword) {
        outcome = 'failure';
        throw invalidCredentials();
      }

      if (this.passwordHasher.needsRehash(user.passwordHash)) {
        const upgradedHash = await this.passwordHasher.hash(input.password);
        await this.users.updatePasswordHash(user._id, upgradedHash, this.now());
      }

      const session = await this.issueSession(user._id);
      return { user: toPublicUser(user), ...session };
    } finally {
      attempt.settle(outcome);
    }
  }

  async authenticate(cookieValue: unknown): Promise<Authentication> {
    const sessionIdHash = this.sessionTokens.sessionHashFromCookie(cookieValue);
    if (sessionIdHash === null) {
      throw unauthenticated();
    }

    const session = await this.authSessions.findBySessionIdHash(sessionIdHash);
    if (session === null) {
      throw unauthenticated();
    }

    const now = this.now();
    if (session.revokedAt !== null || session.expiresAt.getTime() <= now.getTime()) {
      throw unauthenticated();
    }

    const user = await this.users.findById(session.userId);
    if (user === null) {
      throw unauthenticated();
    }

    return { user: toPublicUser(user) };
  }

  checkIpRateLimit(ipAddress: string): void {
    this.rateLimiter.consumeIp(ipAddress);
  }

  async logout(cookieValue: unknown): Promise<void> {
    const sessionIdHash = this.sessionTokens.sessionHashFromCookie(cookieValue);
    if (sessionIdHash !== null) {
      await this.authSessions.revoke(sessionIdHash, this.now());
    }
  }

  private async issueSession(userId: ObjectId): Promise<{ cookieValue: string; expiresAt: Date }> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + AUTH_SESSION_TTL_MS);
    const material = this.sessionTokens.create();
    const session = AuthSessionDocumentSchema.parse({
      _id: new ObjectId(),
      schemaVersion: AUTH_SCHEMA_VERSION,
      sessionIdHash: material.sessionIdHash,
      userId,
      createdAt: now,
      expiresAt,
      revokedAt: null,
    });
    await this.authSessions.insert(session);
    return { cookieValue: material.cookieValue, expiresAt };
  }

  private now(): Date {
    return new Date(this.clock().getTime());
  }
}

interface CreateIdentityServiceOptions {
  database: Db;
  sessionSecret: string;
  clock?: Clock;
}

export async function createIdentityService(
  options: CreateIdentityServiceOptions,
): Promise<IdentityService> {
  const clock = options.clock ?? systemClock;
  const passwordHasher = new Argon2PasswordHasher();
  await ensureAuthIndexes(options.database);
  const dummyPasswordHash = await passwordHasher.hash(randomBytes(32).toString('base64url'));

  return new IdentityService({
    users: new MongoUserRepository(options.database),
    authSessions: new MongoAuthSessionRepository(options.database),
    passwordHasher,
    sessionTokens: new SessionTokenService(options.sessionSecret),
    rateLimiter: new AuthRateLimiter(options.sessionSecret, clock),
    clock,
    dummyPasswordHash,
  });
}
