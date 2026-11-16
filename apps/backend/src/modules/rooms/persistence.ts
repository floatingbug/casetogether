import { ClientRequestIdSchema } from '@casetogether/shared';
import { ObjectId } from 'mongodb';
import { z } from 'zod';

export const ROOM_SCHEMA_VERSION = 1;
export const ROOM_MAX_PLAYERS = 4;

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const opaqueEventIdSchema = z.string().regex(/^[a-f0-9]{24}$/);

export const RoomOperationSchema = z.enum(['create', 'join', 'rotate', 'leave']);
export type RoomOperation = z.infer<typeof RoomOperationSchema>;

export const RoomMemberDocumentSchema = z
  .object({
    userId: z.instanceof(ObjectId),
    role: z.enum(['host', 'member']),
    joinedAt: z.date(),
  })
  .strict();

export const InvitationDocumentSchema = z
  .object({
    codeHash: sha256HexSchema,
    createdAt: z.date(),
    expiresAt: z.date(),
  })
  .strict();

export const ActionReceiptResultSchema = z
  .object({
    roomId: z.instanceof(ObjectId),
    roomVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    eventId: opaqueEventIdSchema.nullable(),
    closed: z.boolean().nullable(),
  })
  .strict();

export const ActionReceiptDocumentSchema = z
  .object({
    actorUserId: z.instanceof(ObjectId),
    operation: RoomOperationSchema,
    aggregateId: z.string().min(1).max(64),
    clientRequestId: ClientRequestIdSchema,
    payloadHash: sha256HexSchema,
    lookupKey: sha256HexSchema,
    result: ActionReceiptResultSchema,
    createdAt: z.date(),
  })
  .strict();

export const RoomDocumentSchema = z
  .object({
    _id: z.instanceof(ObjectId),
    schemaVersion: z.literal(ROOM_SCHEMA_VERSION),
    status: z.enum(['waiting', 'ready', 'in_progress', 'closed']),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    hostUserId: z.instanceof(ObjectId),
    members: z.array(RoomMemberDocumentSchema).min(1).max(ROOM_MAX_PLAYERS),
    maxPlayers: z.literal(ROOM_MAX_PLAYERS),
    invitation: InvitationDocumentSchema,
    activeSessionId: z.instanceof(ObjectId).nullable(),
    actionReceipts: z.array(ActionReceiptDocumentSchema),
    createdAt: z.date(),
    updatedAt: z.date(),
    expiresAt: z.date(),
    deleteAfter: z.date().nullable(),
  })
  .strict()
  .superRefine((room, context) => {
    const memberIds = new Set<string>();
    room.members.forEach((member, index) => {
      const key = member.userId.toHexString();
      if (memberIds.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['members', index, 'userId'],
          message: 'Room members must be unique',
        });
      }
      memberIds.add(key);
    });

    const hosts = room.members.filter((member) => member.role === 'host');
    if (hosts.length !== 1 || hosts[0]?.userId.equals(room.hostUserId) !== true) {
      context.addIssue({
        code: 'custom',
        path: ['hostUserId'],
        message: 'Room host must be the single host member',
      });
    }
    const receiptKeys = new Set<string>();
    room.actionReceipts.forEach((receipt, index) => {
      if (!receipt.result.roomId.equals(room._id)) {
        context.addIssue({
          code: 'custom',
          path: ['actionReceipts', index, 'result', 'roomId'],
          message: 'A room receipt must reference its own room',
        });
      }
      const expectedAggregate = receipt.operation === 'create' ? 'new' : room._id.toHexString();
      if (receipt.aggregateId !== expectedAggregate) {
        context.addIssue({
          code: 'custom',
          path: ['actionReceipts', index, 'aggregateId'],
          message: 'A room receipt must use its authoritative aggregate scope',
        });
      }
      if (receiptKeys.has(receipt.lookupKey)) {
        context.addIssue({
          code: 'custom',
          path: ['actionReceipts', index, 'lookupKey'],
          message: 'Room action receipts must be unique',
        });
      }
      receiptKeys.add(receipt.lookupKey);
    });
    if (room.status === 'waiting' && room.members.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['members'],
        message: 'A waiting room has exactly one member',
      });
    }
    if (['ready', 'in_progress'].includes(room.status) && room.members.length < 2) {
      context.addIssue({
        code: 'custom',
        path: ['members'],
        message: 'An active multiplayer room has at least two members',
      });
    }
  });

export type RoomMemberDocument = z.infer<typeof RoomMemberDocumentSchema>;
export type InvitationDocument = z.infer<typeof InvitationDocumentSchema>;
export type ActionReceiptResult = z.infer<typeof ActionReceiptResultSchema>;
export type ActionReceiptDocument = z.infer<typeof ActionReceiptDocumentSchema>;
export type RoomDocument = z.infer<typeof RoomDocumentSchema>;
