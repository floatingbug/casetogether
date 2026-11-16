import type { Db } from 'mongodb';

export async function ensureRoomIndexes(database: Db): Promise<void> {
  const rooms = database.collection('rooms');

  await rooms.createIndex(
    { 'invitation.codeHash': 1 },
    { unique: true, name: 'rooms_invitation_codeHash_unique' },
  );
  await rooms.createIndex({ _id: 1, 'members.userId': 1 }, { name: 'rooms_id_members_userId' });
  await rooms.createIndex(
    {
      'actionReceipts.actorUserId': 1,
      'actionReceipts.operation': 1,
      'actionReceipts.clientRequestId': 1,
    },
    { name: 'rooms_actionReceipts_actor_operation_request' },
  );
  await rooms.createIndex(
    { 'actionReceipts.lookupKey': 1 },
    { unique: true, name: 'rooms_actionReceipts_lookupKey_unique' },
  );
  await rooms.createIndex(
    { deleteAfter: 1 },
    { expireAfterSeconds: 0, name: 'rooms_deleteAfter_ttl' },
  );
}
