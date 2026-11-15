import { z } from 'zod';
import { CatalogQuestionSchema, ClueSchema, SuspectDialogueSchema } from './cases.js';
import { ApiErrorSchema, ErrorResponseSchema } from './errors.js';
import { GameSnapshotSchema } from './game.js';
import {
  ChatContentSchema,
  ClientRequestIdSchema,
  EventIdSchema,
  FreeTextQuestionSchema,
  RoomIdSchema,
  ServerIsoDateTimeSchema,
  SessionIdSchema,
  SuspectIdSchema,
  QuestionIdSchema,
  UserIdSchema,
  VersionSchema,
} from './primitives.js';
import {
  ChatMessageSchema,
  PresenceMemberSchema,
  RoomMemberSchema,
  RoomSnapshotSchema,
} from './rooms.js';
import { rejectDuplicateIds } from './validation.js';

export interface SocketAckSuccess<T> {
  ok: true;
  data: T;
}

export interface SocketAckFailure {
  ok: false;
  error: z.infer<typeof ApiErrorSchema>;
  clientRequestId?: z.infer<typeof ClientRequestIdSchema>;
}

export type SocketAck<T> = SocketAckSuccess<T> | SocketAckFailure;

export const SocketAckFailureSchema = z
  .object({
    ok: z.literal(false),
    error: ApiErrorSchema,
    clientRequestId: ClientRequestIdSchema.optional(),
  })
  .strict();

export function createSocketAckSchema<DataSchema extends z.ZodType>(dataSchema: DataSchema) {
  return z.discriminatedUnion('ok', [
    z
      .object({
        ok: z.literal(true),
        data: dataSchema,
      })
      .strict(),
    SocketAckFailureSchema,
  ]);
}

export const RoomJoinRequestSchema = z
  .object({
    roomId: RoomIdSchema,
  })
  .strict();
export const RoomSyncRequestSchema = RoomJoinRequestSchema;

export const RoomJoinAckDataSchema = z
  .object({
    room: RoomSnapshotSchema,
    game: GameSnapshotSchema.nullable(),
    serverTime: ServerIsoDateTimeSchema,
  })
  .strict();
export const RoomJoinAckSchema = createSocketAckSchema(RoomJoinAckDataSchema);
export const RoomSyncAckSchema = createSocketAckSchema(RoomJoinAckDataSchema);

export const RoomLeaveRequestSchema = z
  .object({
    roomId: RoomIdSchema,
    clientRequestId: ClientRequestIdSchema,
    expectedVersion: VersionSchema,
  })
  .strict();
export const RoomLeaveAckDataSchema = z
  .object({
    roomId: RoomIdSchema,
    roomVersion: VersionSchema,
    closed: z.boolean(),
  })
  .strict();
export const RoomLeaveAckSchema = createSocketAckSchema(RoomLeaveAckDataSchema);

export const ChatSendRequestSchema = z
  .object({
    roomId: RoomIdSchema,
    clientRequestId: ClientRequestIdSchema,
    content: ChatContentSchema,
  })
  .strict();
export const ChatSendAckDataSchema = z
  .object({
    message: ChatMessageSchema,
  })
  .strict();
export const ChatSendAckSchema = createSocketAckSchema(ChatSendAckDataSchema);

const questionRequestFields = {
  sessionId: SessionIdSchema,
  clientRequestId: ClientRequestIdSchema,
  expectedVersion: VersionSchema,
  suspectId: SuspectIdSchema,
};

export const CatalogQuestionRequestSchema = z
  .object({
    ...questionRequestFields,
    mode: z.literal('catalog'),
    questionId: QuestionIdSchema,
  })
  .strict();

export const FreeTextQuestionRequestSchema = z
  .object({
    ...questionRequestFields,
    mode: z.literal('free_text'),
    questionText: FreeTextQuestionSchema,
  })
  .strict();

export const SuspectQuestionRequestSchema = z.discriminatedUnion('mode', [
  CatalogQuestionRequestSchema,
  FreeTextQuestionRequestSchema,
]);

export const RoomSnapshotEventSchema = z
  .object({
    snapshot: RoomSnapshotSchema,
    emittedAt: ServerIsoDateTimeSchema,
  })
  .strict();

export const GameSnapshotEventSchema = z
  .object({
    snapshot: GameSnapshotSchema,
    emittedAt: ServerIsoDateTimeSchema,
  })
  .strict();

export const RoomPresenceEventSchema = z
  .object({
    roomId: RoomIdSchema,
    members: z.array(PresenceMemberSchema).min(1).max(4),
    emittedAt: ServerIsoDateTimeSchema,
  })
  .strict()
  .superRefine((event, context) => {
    rejectDuplicateIds(event.members, (member) => member.userId, ['members'], context);
  });

function createRoomEventSchema<TypeSchema extends z.ZodType, PayloadSchema extends z.ZodType>(
  type: TypeSchema,
  payload: PayloadSchema,
) {
  return z
    .object({
      eventId: EventIdSchema,
      roomId: RoomIdSchema,
      version: VersionSchema,
      type,
      occurredAt: ServerIsoDateTimeSchema,
      payload,
    })
    .strict();
}

export const RoomMemberJoinedEventSchema = createRoomEventSchema(
  z.literal('room.member_joined'),
  z.object({ member: RoomMemberSchema }).strict(),
);
export const RoomMemberLeftEventSchema = createRoomEventSchema(
  z.literal('room.member_left'),
  z
    .object({
      userId: UserIdSchema,
      status: z.enum(['waiting', 'ready']),
    })
    .strict(),
);
export const RoomClosedEventSchema = createRoomEventSchema(
  z.literal('room.closed'),
  z.object({ reason: z.enum(['host_left', 'expired']) }).strict(),
);
export const RoomInvitationRotatedEventSchema = createRoomEventSchema(
  z.literal('room.invitation_rotated'),
  z.object({ expiresAt: ServerIsoDateTimeSchema }).strict(),
);
export const RoomStartedEventSchema = createRoomEventSchema(
  z.literal('room.started'),
  z.object({ sessionId: SessionIdSchema }).strict(),
);

export const RoomEventSchema = z.discriminatedUnion('type', [
  RoomMemberJoinedEventSchema,
  RoomMemberLeftEventSchema,
  RoomClosedEventSchema,
  RoomInvitationRotatedEventSchema,
  RoomStartedEventSchema,
]);

export const ChatMessageEventSchema = z
  .object({
    message: ChatMessageSchema,
  })
  .strict();

function createGameEventSchema<TypeSchema extends z.ZodType, PayloadSchema extends z.ZodType>(
  type: TypeSchema,
  payload: PayloadSchema,
) {
  return z
    .object({
      eventId: EventIdSchema,
      sessionId: SessionIdSchema,
      version: VersionSchema,
      type,
      occurredAt: ServerIsoDateTimeSchema,
      payload,
    })
    .strict();
}

export const GameStartedEventSchema = createGameEventSchema(
  z.literal('game.started'),
  z.object({ snapshot: GameSnapshotSchema }).strict(),
).superRefine((event, context) => {
  validateSnapshotEnvelope(event, 'investigating', context);
  if (event.version !== 1 || event.payload.snapshot.version !== 1) {
    context.addIssue({
      code: 'custom',
      path: ['version'],
      message: 'A game.started event and its snapshot must use version 1',
    });
  }
});

export const SuspectAnsweredPayloadSchema = z
  .object({
    dialogue: SuspectDialogueSchema.nullable(),
    newPublicClues: z.array(ClueSchema).max(500),
    newPrivateClues: z.array(ClueSchema).max(500),
    availableQuestions: z.array(CatalogQuestionSchema).max(500),
    phase: z.literal('investigating'),
  })
  .strict()
  .superRefine((payload, context) => {
    rejectDuplicateIds(payload.newPublicClues, (clue) => clue.id, ['newPublicClues'], context);
    rejectDuplicateIds(payload.newPrivateClues, (clue) => clue.id, ['newPrivateClues'], context);
    rejectDuplicateIds(
      payload.availableQuestions,
      (question) => question.questionId,
      ['availableQuestions'],
      context,
    );
    if (payload.dialogue !== null && payload.dialogue.mode !== 'catalog') {
      context.addIssue({
        code: 'custom',
        path: ['dialogue', 'mode'],
        message: 'A suspect.answered event can only contain catalog dialogue',
      });
    }
  });

export const SuspectAnsweredEventSchema = createGameEventSchema(
  z.literal('suspect.answered'),
  SuspectAnsweredPayloadSchema,
);

export const SuspectFreeTextAnsweredEventSchema = createGameEventSchema(
  z.literal('suspect.free_text_answered'),
  z.object({ dialogue: SuspectDialogueSchema }).strict(),
).superRefine((event, context) => {
  if (event.payload.dialogue.mode !== 'free_text') {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'dialogue', 'mode'],
      message: 'A suspect.free_text_answered event requires free-text dialogue',
    });
  }
});

export const GameCompletedEventSchema = createGameEventSchema(
  z.literal('game.completed'),
  z.object({ snapshot: GameSnapshotSchema }).strict(),
).superRefine((event, context) => {
  validateSnapshotEnvelope(event, 'completed', context);
});

export const GameAbandonedEventSchema = createGameEventSchema(
  z.literal('game.abandoned'),
  z.object({ snapshot: GameSnapshotSchema }).strict(),
).superRefine((event, context) => {
  validateSnapshotEnvelope(event, 'abandoned', context);
});

type SnapshotEnvelope = {
  sessionId: string;
  version: number;
  payload: { snapshot: z.infer<typeof GameSnapshotSchema> };
};

function validateSnapshotEnvelope(
  event: SnapshotEnvelope,
  expectedPhase: z.infer<typeof GameSnapshotSchema>['phase'],
  context: z.RefinementCtx,
): void {
  const { snapshot } = event.payload;
  if (snapshot.phase !== expectedPhase) {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'snapshot', 'phase'],
      message: `Snapshot phase must be ${expectedPhase}`,
    });
  }
  if (snapshot.sessionId !== event.sessionId) {
    context.addIssue({
      code: 'custom',
      path: ['sessionId'],
      message: 'The event and snapshot sessionId must match',
    });
  }
  if (snapshot.version !== event.version) {
    context.addIssue({
      code: 'custom',
      path: ['version'],
      message: 'The event and snapshot versions must match',
    });
  }
}

export const GameEventSchema = z.discriminatedUnion('type', [
  GameStartedEventSchema,
  SuspectAnsweredEventSchema,
  SuspectFreeTextAnsweredEventSchema,
  GameCompletedEventSchema,
  GameAbandonedEventSchema,
]);

export const SuspectQuestionAckDataSchema = z
  .object({
    event: GameEventSchema,
  })
  .strict();
export const SuspectQuestionAckSchema = createSocketAckSchema(SuspectQuestionAckDataSchema);

export const GameErrorEventSchema = z
  .object({
    error: ApiErrorSchema,
    clientRequestId: ClientRequestIdSchema.optional(),
  })
  .strict();

export const HandshakeErrorDataSchema = ErrorResponseSchema;

export type RoomJoinRequest = z.infer<typeof RoomJoinRequestSchema>;
export type RoomSyncRequest = z.infer<typeof RoomSyncRequestSchema>;
export type RoomJoinAckData = z.infer<typeof RoomJoinAckDataSchema>;
export type RoomJoinAck = z.infer<typeof RoomJoinAckSchema>;
export type RoomSyncAck = z.infer<typeof RoomSyncAckSchema>;
export type RoomLeaveRequest = z.infer<typeof RoomLeaveRequestSchema>;
export type RoomLeaveAckData = z.infer<typeof RoomLeaveAckDataSchema>;
export type RoomLeaveAck = z.infer<typeof RoomLeaveAckSchema>;
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>;
export type ChatSendAckData = z.infer<typeof ChatSendAckDataSchema>;
export type ChatSendAck = z.infer<typeof ChatSendAckSchema>;
export type CatalogQuestionRequest = z.infer<typeof CatalogQuestionRequestSchema>;
export type FreeTextQuestionRequest = z.infer<typeof FreeTextQuestionRequestSchema>;
export type SuspectQuestionRequest = z.infer<typeof SuspectQuestionRequestSchema>;
export type RoomSnapshotEvent = z.infer<typeof RoomSnapshotEventSchema>;
export type GameSnapshotEvent = z.infer<typeof GameSnapshotEventSchema>;
export type RoomPresenceEvent = z.infer<typeof RoomPresenceEventSchema>;
export type RoomMemberJoinedEvent = z.infer<typeof RoomMemberJoinedEventSchema>;
export type RoomMemberLeftEvent = z.infer<typeof RoomMemberLeftEventSchema>;
export type RoomClosedEvent = z.infer<typeof RoomClosedEventSchema>;
export type RoomInvitationRotatedEvent = z.infer<typeof RoomInvitationRotatedEventSchema>;
export type RoomStartedEvent = z.infer<typeof RoomStartedEventSchema>;
export type RoomEvent = z.infer<typeof RoomEventSchema>;
export type ChatMessageEvent = z.infer<typeof ChatMessageEventSchema>;
export type GameStartedEvent = z.infer<typeof GameStartedEventSchema>;
export type SuspectAnsweredPayload = z.infer<typeof SuspectAnsweredPayloadSchema>;
export type SuspectAnsweredEvent = z.infer<typeof SuspectAnsweredEventSchema>;
export type SuspectFreeTextAnsweredEvent = z.infer<typeof SuspectFreeTextAnsweredEventSchema>;
export type GameCompletedEvent = z.infer<typeof GameCompletedEventSchema>;
export type GameAbandonedEvent = z.infer<typeof GameAbandonedEventSchema>;
export type GameEvent = z.infer<typeof GameEventSchema>;
export type SuspectQuestionAckData = z.infer<typeof SuspectQuestionAckDataSchema>;
export type SuspectQuestionAck = z.infer<typeof SuspectQuestionAckSchema>;
export type GameErrorEvent = z.infer<typeof GameErrorEventSchema>;
export type HandshakeErrorData = z.infer<typeof HandshakeErrorDataSchema>;
