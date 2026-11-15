import { z } from 'zod';
import { CaseSummarySchema } from './cases.js';
import { GameSnapshotSchema } from './game.js';
import {
  CaseIdSchema,
  ClientRequestIdSchema,
  DisplayNameSchema,
  EmailSchema,
  InvitationCodeSchema,
  PasswordSchema,
  SuspectIdSchema,
  VersionSchema,
} from './primitives.js';
import {
  CreateRoomResponseSchema,
  PublicUserSchema,
  RoomSnapshotSchema,
  RotateInvitationResponseSchema,
} from './rooms.js';
import { rejectDuplicateIds } from './validation.js';

export function createSuccessResponseSchema<DataSchema extends z.ZodType>(dataSchema: DataSchema) {
  return z
    .object({
      data: dataSchema,
    })
    .strict();
}

export const RegisterRequestSchema = z
  .object({
    email: EmailSchema,
    password: PasswordSchema,
    displayName: DisplayNameSchema,
  })
  .strict();

export const LoginRequestSchema = z
  .object({
    email: EmailSchema,
    password: z.string().min(1).max(128),
  })
  .strict();

export const ClientRequestSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
  })
  .strict();

export const JoinRoomRequestSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    code: InvitationCodeSchema,
  })
  .strict();

export const RotateInvitationRequestSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    expectedVersion: VersionSchema,
  })
  .strict();

export const StartGameRequestSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    caseId: CaseIdSchema,
    expectedVersion: VersionSchema,
  })
  .strict();

export const FinalSubmissionRequestSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    expectedVersion: VersionSchema,
    suspectId: SuspectIdSchema,
  })
  .strict();

export const UserResponseSchema = createSuccessResponseSchema(PublicUserSchema);
export const CreateRoomResponseEnvelopeSchema =
  createSuccessResponseSchema(CreateRoomResponseSchema);
export const RotateInvitationResponseEnvelopeSchema = createSuccessResponseSchema(
  RotateInvitationResponseSchema,
);
export const RoomResponseSchema = createSuccessResponseSchema(RoomSnapshotSchema);
export const GameResponseSchema = createSuccessResponseSchema(GameSnapshotSchema);

export const CaseListDataSchema = z
  .object({
    items: z.array(CaseSummarySchema).max(100),
  })
  .strict()
  .superRefine((list, context) => {
    rejectDuplicateIds(list.items, (item) => item.id, ['items'], context);
  });
export const CaseListResponseSchema = createSuccessResponseSchema(CaseListDataSchema);

export const HealthDataSchema = z
  .object({
    status: z.literal('ok'),
  })
  .strict();
export const HealthResponseSchema = createSuccessResponseSchema(HealthDataSchema);

export const ReadinessDataSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    checks: z
      .object({
        mongodb: z.enum(['up', 'down']),
      })
      .strict(),
  })
  .strict()
  .superRefine((readiness, context) => {
    if (readiness.status === 'ready' && readiness.checks.mongodb !== 'up') {
      context.addIssue({
        code: 'custom',
        path: ['checks', 'mongodb'],
        message: 'Readiness cannot be ready while MongoDB is down',
      });
    }
    if (readiness.status === 'not_ready' && readiness.checks.mongodb !== 'down') {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Readiness with all required checks up must be ready',
      });
    }
  });
export const ReadinessResponseSchema = createSuccessResponseSchema(ReadinessDataSchema);

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type ClientRequest = z.infer<typeof ClientRequestSchema>;
export type JoinRoomRequest = z.infer<typeof JoinRoomRequestSchema>;
export type RotateInvitationRequest = z.infer<typeof RotateInvitationRequestSchema>;
export type StartGameRequest = z.infer<typeof StartGameRequestSchema>;
export type FinalSubmissionRequest = z.infer<typeof FinalSubmissionRequestSchema>;
export type UserResponse = z.infer<typeof UserResponseSchema>;
export type CreateRoomResponseEnvelope = z.infer<typeof CreateRoomResponseEnvelopeSchema>;
export type RotateInvitationResponseEnvelope = z.infer<
  typeof RotateInvitationResponseEnvelopeSchema
>;
export type RoomResponse = z.infer<typeof RoomResponseSchema>;
export type GameResponse = z.infer<typeof GameResponseSchema>;
export type CaseListData = z.infer<typeof CaseListDataSchema>;
export type CaseListResponse = z.infer<typeof CaseListResponseSchema>;
export type HealthData = z.infer<typeof HealthDataSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ReadinessData = z.infer<typeof ReadinessDataSchema>;
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
