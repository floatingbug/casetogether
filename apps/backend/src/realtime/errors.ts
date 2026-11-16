import { randomUUID } from 'node:crypto';
import { ApiErrorSchema, SocketAckFailureSchema, type ApiError } from '@casetogether/shared';
import { ZodError } from 'zod';
import { ApplicationError } from '../application-error.js';
import { validationError } from '../http/validation.js';

export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;

export type InternalErrorLogger = (requestId: string) => void;

export function payloadSize(payload: unknown): number {
  const serialized: unknown = JSON.stringify(payload);
  return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : 0;
}

export function payloadTooLarge(): ApplicationError {
  return new ApplicationError('PAYLOAD_TOO_LARGE', 'Socket payload exceeds the 16 KiB limit');
}

export function toSocketFailure(
  error: unknown,
  clientRequestId: string | undefined,
  logInternalError: InternalErrorLogger,
) {
  const applicationError =
    error instanceof ZodError
      ? validationError(error)
      : error instanceof ApplicationError
        ? error
        : undefined;

  if (applicationError === undefined) {
    const requestId = randomUUID();
    logInternalError(requestId);
    return SocketAckFailureSchema.parse({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        requestId,
      },
      ...(clientRequestId === undefined ? {} : { clientRequestId }),
    });
  }

  const apiError: ApiError = ApiErrorSchema.parse({
    code: applicationError.code,
    message: applicationError.message,
    requestId: randomUUID(),
    ...(applicationError.details === undefined ? {} : { details: applicationError.details }),
  });
  return SocketAckFailureSchema.parse({
    ok: false,
    error: apiError,
    ...(clientRequestId === undefined ? {} : { clientRequestId }),
  });
}
