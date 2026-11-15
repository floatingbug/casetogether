import type { FieldError } from '@casetogether/shared';
import type { ZodError } from 'zod';
import { ApplicationError } from '../application-error.js';

export function validationError(error: ZodError): ApplicationError {
  const fieldErrors: FieldError[] = error.issues.slice(0, 50).map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    code: issue.code,
  }));

  return new ApplicationError('VALIDATION_ERROR', 'Request validation failed', { fieldErrors });
}
