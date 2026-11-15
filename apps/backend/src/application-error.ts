import type { ErrorCode, ErrorDetails } from '@casetogether/shared';

export class ApplicationError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.details = details;
  }
}
