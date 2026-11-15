import { z } from 'zod';
import { OpaqueIdSchema, VersionSchema } from './primitives.js';

export const ErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'CSRF_REJECTED',
  'FORBIDDEN',
  'NOT_FOUND',
  'EMAIL_ALREADY_REGISTERED',
  'INVITATION_INVALID',
  'ROOM_FULL',
  'ROOM_NOT_JOINABLE',
  'ROOM_CLOSED',
  'QUESTION_NOT_AVAILABLE',
  'INVALID_STATE_TRANSITION',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'OPERATION_IN_PROGRESS',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'AI_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export const FieldErrorSchema = z
  .object({
    path: z.string().max(100),
    code: z.string().max(64),
  })
  .strict();

export const ErrorDetailsSchema = z
  .object({
    fieldErrors: z.array(FieldErrorSchema).max(50).optional(),
    retryAfterSeconds: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    currentVersion: VersionSchema.optional(),
  })
  .strict();

export const ApiErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(300),
    requestId: OpaqueIdSchema,
    details: ErrorDetailsSchema.optional(),
  })
  .strict()
  .superRefine((error, context) => {
    const details = error.details;
    if (details === undefined) {
      return;
    }

    if (details.fieldErrors !== undefined && error.code !== 'VALIDATION_ERROR') {
      context.addIssue({
        code: 'custom',
        path: ['details', 'fieldErrors'],
        message: 'fieldErrors are only valid for VALIDATION_ERROR',
      });
    }
    if (details.retryAfterSeconds !== undefined && error.code !== 'RATE_LIMITED') {
      context.addIssue({
        code: 'custom',
        path: ['details', 'retryAfterSeconds'],
        message: 'retryAfterSeconds is only valid for RATE_LIMITED',
      });
    }
    if (details.currentVersion !== undefined && error.code !== 'VERSION_CONFLICT') {
      context.addIssue({
        code: 'custom',
        path: ['details', 'currentVersion'],
        message: 'currentVersion is only valid for VERSION_CONFLICT',
      });
    }
  });

export const ErrorResponseSchema = z
  .object({
    error: ApiErrorSchema,
  })
  .strict();

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type FieldError = z.infer<typeof FieldErrorSchema>;
export type ErrorDetails = z.infer<typeof ErrorDetailsSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
