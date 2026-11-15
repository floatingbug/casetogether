import { LoginRequestSchema, RegisterRequestSchema } from '@casetogether/shared';
import type { z } from 'zod';

export type AuthField = 'email' | 'password' | 'displayName';
export type AuthFieldErrors = Partial<Record<AuthField, string>>;

interface ValidationSuccess<Data> {
  data: Data;
  errors: AuthFieldErrors;
}

interface ValidationFailure {
  data: null;
  errors: AuthFieldErrors;
}

export type ValidationResult<Data> = ValidationSuccess<Data> | ValidationFailure;

function firstField(
  issues: readonly z.core.$ZodIssue[],
  field: AuthField,
): z.core.$ZodIssue | undefined {
  return issues.find((issue) => issue.path[0] === field);
}

function fieldMessage(
  issue: z.core.$ZodIssue | undefined,
  field: AuthField,
  mode: 'login' | 'register',
): string | undefined {
  if (issue === undefined) {
    return undefined;
  }

  if (field === 'email') {
    return 'Gib eine gültige E-Mail-Adresse mit höchstens 254 Zeichen ein.';
  }
  if (field === 'password') {
    if (mode === 'login') {
      return issue.code === 'too_small'
        ? 'Gib dein Passwort ein.'
        : 'Das Passwort darf höchstens 128 Zeichen lang sein.';
    }
    return 'Das Passwort muss zwischen 12 und 128 Zeichen lang sein.';
  }
  return 'Der Anzeigename muss 1–32 Zeichen ohne Steuerzeichen enthalten.';
}

function validationFailure(
  issues: readonly z.core.$ZodIssue[],
  fields: readonly AuthField[],
  mode: 'login' | 'register',
): ValidationFailure {
  const errors: AuthFieldErrors = {};
  for (const field of fields) {
    const message = fieldMessage(firstField(issues, field), field, mode);
    if (message !== undefined) {
      errors[field] = message;
    }
  }
  if (Object.keys(errors).length === 0) {
    errors[fields[0] ?? 'email'] = 'Bitte prüfe diese Eingabe.';
  }
  return { data: null, errors };
}

export function validateLogin(input: {
  email: string;
  password: string;
}): ValidationResult<z.infer<typeof LoginRequestSchema>> {
  const result = LoginRequestSchema.safeParse(input);
  return result.success
    ? { data: result.data, errors: {} }
    : validationFailure(result.error.issues, ['email', 'password'], 'login');
}

export function validateRegister(input: {
  email: string;
  password: string;
  displayName: string;
}): ValidationResult<z.infer<typeof RegisterRequestSchema>> {
  const result = RegisterRequestSchema.safeParse(input);
  return result.success
    ? { data: result.data, errors: {} }
    : validationFailure(result.error.issues, ['displayName', 'email', 'password'], 'register');
}
