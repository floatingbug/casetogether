import type { Db } from 'mongodb';

export async function ensureAuthIndexes(database: Db): Promise<void> {
  const users = database.collection('users');
  const authSessions = database.collection('authSessions');

  await users.createIndex(
    { emailNormalized: 1 },
    { unique: true, name: 'users_emailNormalized_unique' },
  );
  await authSessions.createIndex(
    { sessionIdHash: 1 },
    { unique: true, name: 'authSessions_sessionIdHash_unique' },
  );
  await authSessions.createIndex(
    { userId: 1, revokedAt: 1 },
    { name: 'authSessions_userId_revokedAt' },
  );
  await authSessions.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'authSessions_expiresAt_ttl' },
  );
}
