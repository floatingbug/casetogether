import {
  ErrorResponseSchema,
  PublicUserSchema,
  type ErrorCode,
  type ErrorDetails,
} from '@casetogether/shared';

export const testUser = PublicUserSchema.parse({
  id: 'user_fixture_1',
  displayName: 'Ada Test',
});

export const fictionalPassword = 'Fiktives-Testpasswort-123!';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function userResponse(status = 200): Response {
  return jsonResponse({ data: testUser }, status);
}

export function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

export function errorResponse(
  code: ErrorCode,
  status: number,
  message = 'Fiktive Fehlerbeschreibung',
  details?: ErrorDetails,
): Response {
  const body = ErrorResponseSchema.parse({
    error: {
      code,
      message,
      requestId: 'request_fixture_1',
      ...(details === undefined ? {} : { details }),
    },
  });
  return jsonResponse(body, status);
}
