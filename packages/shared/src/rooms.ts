import { z } from 'zod';
import {
  ChatContentSchema,
  DisplayNameSchema,
  MessageIdSchema,
  RoomIdSchema,
  ServerIsoDateTimeSchema,
  SessionIdSchema,
  UserIdSchema,
  VersionSchema,
  InvitationCodeSchema,
} from './primitives.js';
import { isChronologicallySorted, rejectDuplicateIds } from './validation.js';

export const RoomStatusSchema = z.enum(['waiting', 'ready', 'in_progress', 'closed']);
export const RoomRoleSchema = z.enum(['host', 'member']);
export const PresenceStatusSchema = z.enum(['online', 'offline']);

export const PublicUserSchema = z
  .object({
    id: UserIdSchema,
    displayName: DisplayNameSchema,
  })
  .strict();

export const RoomMemberSchema = z
  .object({
    user: PublicUserSchema,
    role: RoomRoleSchema,
    joinedAt: ServerIsoDateTimeSchema,
  })
  .strict();

export const RoomSummarySchema = z
  .object({
    id: RoomIdSchema,
    status: RoomStatusSchema,
    version: VersionSchema,
    host: PublicUserSchema,
    members: z.array(RoomMemberSchema).min(1).max(4),
    maxPlayers: z.literal(4),
    activeSessionId: SessionIdSchema.nullable(),
    createdAt: ServerIsoDateTimeSchema,
    expiresAt: ServerIsoDateTimeSchema,
  })
  .strict()
  .superRefine((room, context) => {
    rejectDuplicateIds(room.members, (member) => member.user.id, ['members'], context);

    const hostIndexes = room.members.flatMap((member, index) =>
      member.role === 'host' ? [index] : [],
    );
    if (hostIndexes.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['members'],
        message: 'Exactly one room member must have the host role',
      });
    }

    const hostIndex = hostIndexes[0];
    if (hostIndex !== undefined && room.members[hostIndex]?.user.id !== room.host.id) {
      context.addIssue({
        code: 'custom',
        path: ['host', 'id'],
        message: 'The host must match the single member with the host role',
      });
    }

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
        message: `${room.status} requires at least two members`,
      });
    }
    if (['waiting', 'ready'].includes(room.status) && room.activeSessionId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['activeSessionId'],
        message: 'A lobby without a started game cannot have an active session',
      });
    }
    if (room.status === 'in_progress' && room.activeSessionId === null) {
      context.addIssue({
        code: 'custom',
        path: ['activeSessionId'],
        message: 'An in-progress room requires an active session',
      });
    }
    if (room.status === 'closed' && room.activeSessionId !== null && room.members.length < 2) {
      context.addIssue({
        code: 'custom',
        path: ['members'],
        message: 'A closed room with a session must retain its started membership',
      });
    }
  });

export const ChatMessageSchema = z
  .object({
    id: MessageIdSchema,
    roomId: RoomIdSchema,
    sender: PublicUserSchema,
    content: ChatContentSchema,
    createdAt: ServerIsoDateTimeSchema,
  })
  .strict();

export const PresenceMemberSchema = z
  .object({
    userId: UserIdSchema,
    status: PresenceStatusSchema,
    changedAt: ServerIsoDateTimeSchema,
  })
  .strict();

export const RoomSnapshotSchema = z
  .object({
    room: RoomSummarySchema,
    recentMessages: z.array(ChatMessageSchema).max(50),
    presence: z.array(PresenceMemberSchema).max(4),
  })
  .strict()
  .superRefine((snapshot, context) => {
    rejectDuplicateIds(
      snapshot.recentMessages,
      (message) => message.id,
      ['recentMessages'],
      context,
    );
    rejectDuplicateIds(snapshot.presence, (member) => member.userId, ['presence'], context);

    if (!isChronologicallySorted(snapshot.recentMessages)) {
      context.addIssue({
        code: 'custom',
        path: ['recentMessages'],
        message: 'Messages must be sorted by createdAt and id',
      });
    }

    snapshot.recentMessages.forEach((message, index) => {
      if (message.roomId !== snapshot.room.id) {
        context.addIssue({
          code: 'custom',
          path: ['recentMessages', index, 'roomId'],
          message: 'A room snapshot can only contain messages from its own room',
        });
      }
    });
  });

export const InvitationSchema = z
  .object({
    code: InvitationCodeSchema,
    expiresAt: ServerIsoDateTimeSchema,
  })
  .strict();

export const SecretReplayRecoverySchema = z.literal('rotate_with_new_client_request_id_if_needed');

export const SecretReplayResponseSchema = z
  .object({
    outcome: z.literal('replayed'),
    roomId: RoomIdSchema,
    invitation: z.null(),
    recovery: SecretReplayRecoverySchema,
  })
  .strict();

export const CreatedRoomResponseSchema = z
  .object({
    outcome: z.literal('created'),
    room: RoomSummarySchema,
    recentMessages: z.array(ChatMessageSchema).max(0),
    presence: z.array(PresenceMemberSchema).max(4),
    invitation: InvitationSchema,
  })
  .strict()
  .superRefine((response, context) => {
    rejectDuplicateIds(response.presence, (member) => member.userId, ['presence'], context);
  });

export const CreateRoomResponseSchema = z.discriminatedUnion('outcome', [
  CreatedRoomResponseSchema,
  SecretReplayResponseSchema,
]);

export const RotatedInvitationResponseSchema = z
  .object({
    outcome: z.literal('rotated'),
    room: RoomSummarySchema,
    invitation: InvitationSchema,
  })
  .strict();

export const RotateInvitationResponseSchema = z.discriminatedUnion('outcome', [
  RotatedInvitationResponseSchema,
  SecretReplayResponseSchema,
]);

export type RoomStatus = z.infer<typeof RoomStatusSchema>;
export type RoomRole = z.infer<typeof RoomRoleSchema>;
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>;
export type PublicUser = z.infer<typeof PublicUserSchema>;
export type RoomMember = z.infer<typeof RoomMemberSchema>;
export type RoomSummary = z.infer<typeof RoomSummarySchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type PresenceMember = z.infer<typeof PresenceMemberSchema>;
export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;
export type Invitation = z.infer<typeof InvitationSchema>;
export type SecretReplayRecovery = z.infer<typeof SecretReplayRecoverySchema>;
export type SecretReplayResponse = z.infer<typeof SecretReplayResponseSchema>;
export type CreatedRoomResponse = z.infer<typeof CreatedRoomResponseSchema>;
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;
export type RotatedInvitationResponse = z.infer<typeof RotatedInvitationResponseSchema>;
export type RotateInvitationResponse = z.infer<typeof RotateInvitationResponseSchema>;
