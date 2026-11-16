import type { Db } from 'mongodb';

export async function ensureGameSessionIndexes(database: Db): Promise<void> {
  const sessions = database.collection('gameSessions');
  await sessions.createIndex({ roomId: 1 }, { unique: true, name: 'gameSessions_roomId_unique' });
  await sessions.createIndex({ _id: 1, version: 1 }, { name: 'gameSessions_id_version_cas' });
  await sessions.createIndex(
    { 'startIntent.status': 1, 'startIntent.createdAt': 1 },
    { name: 'gameSessions_startIntent_recovery' },
  );
  await sessions.createIndex(
    { deleteAfter: 1 },
    { expireAfterSeconds: 0, name: 'gameSessions_deleteAfter_ttl' },
  );
}
