import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ApiErrorSchema,
  ChatContentSchema,
  ClientRequestIdSchema,
  DisplayNameSchema,
  EmailSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  InvitationCodeSchema,
  IsoDateTimeSchema,
  LoginRequestSchema,
  PasswordSchema,
  ReadinessResponseSchema,
  RegisterRequestSchema,
  RoomIdSchema,
  ServerIsoDateTimeSchema,
  StartGameRequestSchema,
  UserIdSchema,
  VersionSchema,
  type RoomId,
  type UserId,
} from '../src/index.js';

describe('primitive schemas', () => {
  it('keeps opaque ID brands non-assignable at compile time', () => {
    const userId = UserIdSchema.parse('shared-value');
    const roomId = RoomIdSchema.parse('shared-value');

    expectTypeOf(userId).toEqualTypeOf<UserId>();
    expectTypeOf(roomId).toEqualTypeOf<RoomId>();
    expectTypeOf(userId).not.toEqualTypeOf<RoomId>();

    // @ts-expect-error A RoomId cannot be used where a UserId is required.
    const invalidAssignment: UserId = roomId;
    void invalidAssignment;
  });

  it.each(['', ' ', '-leading', 'contains/slash', 'a'.repeat(65)])(
    'rejects invalid opaque ID %j',
    (value) => {
      expect(UserIdSchema.safeParse(value).success).toBe(false);
    },
  );

  it('accepts all UUID v4 variant letter cases and rejects other versions', () => {
    expect(ClientRequestIdSchema.parse('123e4567-e89b-42d3-a456-426614174000')).toBe(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(ClientRequestIdSchema.safeParse('123E4567-E89B-42D3-A456-426614174000').success).toBe(
      true,
    );
    expect(ClientRequestIdSchema.safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(
      false,
    );
    expect(ClientRequestIdSchema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('accepts RFC3339 input but enforces UTC milliseconds for server output', () => {
    expect(IsoDateTimeSchema.parse('2026-11-15T13:00:00+01:00')).toBe('2026-11-15T13:00:00+01:00');
    expect(ServerIsoDateTimeSchema.parse('2026-11-15T12:00:00.000Z')).toBe(
      '2026-11-15T12:00:00.000Z',
    );
    expect(ServerIsoDateTimeSchema.safeParse('2026-11-15T13:00:00.000+01:00').success).toBe(false);
    expect(ServerIsoDateTimeSchema.safeParse('2026-11-15T12:00:00Z').success).toBe(false);
    expect(ServerIsoDateTimeSchema.safeParse('2026-02-30T12:00:00.000Z').success).toBe(false);
  });

  it('normalizes email and display names without changing passwords', () => {
    expect(EmailSchema.parse('  USER@Example.COM ')).toBe('user@example.com');
    expect(DisplayNameSchema.parse('  Cafe\u0301  ')).toBe('Café');
    expect(PasswordSchema.parse(' 123456789012 ')).toBe(' 123456789012 ');
    expect(DisplayNameSchema.safeParse('bad\u0000name').success).toBe(false);
    expect(PasswordSchema.safeParse('12345678901').success).toBe(false);
    expect(PasswordSchema.safeParse('x'.repeat(129)).success).toBe(false);
  });

  it('enforces text, code and safe integer boundaries', () => {
    expect(ChatContentSchema.safeParse('   ').success).toBe(false);
    expect(ChatContentSchema.safeParse('x'.repeat(1001)).success).toBe(false);
    expect(InvitationCodeSchema.safeParse('ABCD-EFGH-JKLM').success).toBe(true);
    expect(InvitationCodeSchema.safeParse('ABCD-EFGH-JKL0').success).toBe(false);
    expect(VersionSchema.safeParse(0).success).toBe(false);
    expect(VersionSchema.safeParse(1.5).success).toBe(false);
    expect(VersionSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });
});

describe('HTTP request and response schemas', () => {
  it('normalizes valid registration input and rejects unknown fields', () => {
    expect(
      RegisterRequestSchema.parse({
        email: ' USER@example.com ',
        password: 'a-secure-password',
        displayName: ' Detektivin ',
      }),
    ).toEqual({
      email: 'user@example.com',
      password: 'a-secure-password',
      displayName: 'Detektivin',
    });

    expect(
      RegisterRequestSchema.safeParse({
        email: 'user@example.com',
        password: 'a-secure-password',
        displayName: 'Detektivin',
        role: 'host',
      }).success,
    ).toBe(false);
  });

  it('uses a non-trimming length-only login password rule', () => {
    expect(LoginRequestSchema.parse({ email: 'u@example.com', password: ' ' }).password).toBe(' ');
    expect(LoginRequestSchema.safeParse({ email: 'u@example.com', password: '' }).success).toBe(
      false,
    );
  });

  it('rejects client-supplied authoritative fields in start requests', () => {
    const valid = {
      clientRequestId: '123e4567-e89b-42d3-a456-426614174000',
      caseId: 'case-1',
      expectedVersion: 1,
    };
    expect(StartGameRequestSchema.safeParse(valid).success).toBe(true);
    expect(StartGameRequestSchema.safeParse({ ...valid, caseVersion: '1.0.0' }).success).toBe(
      false,
    );
    expect(StartGameRequestSchema.safeParse({ ...valid, hostUserId: 'user-1' }).success).toBe(
      false,
    );
  });

  it('validates the exact health body and rejects additions', () => {
    expect(HealthResponseSchema.parse({ data: { status: 'ok' } })).toEqual({
      data: { status: 'ok' },
    });
    expect(HealthResponseSchema.safeParse({ data: { status: 'ok', provider: 'up' } }).success).toBe(
      false,
    );
  });

  it('keeps readiness internally consistent and provider-free', () => {
    expect(
      ReadinessResponseSchema.parse({
        data: { status: 'not_ready', checks: { mongodb: 'down' } },
      }),
    ).toEqual({ data: { status: 'not_ready', checks: { mongodb: 'down' } } });
    expect(
      ReadinessResponseSchema.safeParse({ data: { status: 'ready', checks: { mongodb: 'up' } } })
        .success,
    ).toBe(true);
    expect(
      ReadinessResponseSchema.safeParse({ data: { status: 'ready', checks: { mongodb: 'down' } } })
        .success,
    ).toBe(false);
    expect(
      ReadinessResponseSchema.safeParse({
        data: { status: 'not_ready', checks: { mongodb: 'down', provider: 'down' } },
      }).success,
    ).toBe(false);
  });
});

describe('safe API errors', () => {
  const base = { message: 'Anfrage abgelehnt', requestId: 'request-1' };

  it.each([
    ['VALIDATION_ERROR', { fieldErrors: [{ path: 'email', code: 'invalid_string' }] }],
    ['RATE_LIMITED', { retryAfterSeconds: 5 }],
    ['VERSION_CONFLICT', { currentVersion: 4 }],
    ['NOT_FOUND', undefined],
  ] as const)('accepts allowed details for %s', (code, details) => {
    expect(ApiErrorSchema.safeParse({ ...base, code, details }).success).toBe(true);
  });

  it.each([
    ['NOT_FOUND', { fieldErrors: [{ path: 'email', code: 'invalid' }] }],
    ['VALIDATION_ERROR', { retryAfterSeconds: 5 }],
    ['RATE_LIMITED', { currentVersion: 4 }],
    ['VERSION_CONFLICT', { retryAfterSeconds: 5 }],
  ] as const)('rejects details outside their error-code scope for %s', (code, details) => {
    expect(ApiErrorSchema.safeParse({ ...base, code, details }).success).toBe(false);
  });

  it('allows an empty root field path without including an input value', () => {
    expect(
      ApiErrorSchema.safeParse({
        ...base,
        code: 'VALIDATION_ERROR',
        details: { fieldErrors: [{ path: '', code: 'invalid_type' }] },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown error details and envelope fields', () => {
    expect(
      ErrorResponseSchema.safeParse({
        error: {
          ...base,
          code: 'INTERNAL_ERROR',
          details: { stack: 'secret stack', password: 'secret' },
        },
        debug: true,
      }).success,
    ).toBe(false);
  });

  it('enforces positive retry and version values', () => {
    expect(
      ApiErrorSchema.safeParse({
        ...base,
        code: 'RATE_LIMITED',
        details: { retryAfterSeconds: 0 },
      }).success,
    ).toBe(false);
    expect(
      ApiErrorSchema.safeParse({
        ...base,
        code: 'VERSION_CONFLICT',
        details: { currentVersion: 0 },
      }).success,
    ).toBe(false);
  });
});
