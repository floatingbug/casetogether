import { HandshakeErrorDataSchema, type HandshakeErrorData } from '@casetogether/shared';

function responseBody(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const context = Reflect.get(error, 'context');
  if (typeof context !== 'object' || context === null) return undefined;
  const responseText = Reflect.get(context, 'responseText');
  if (typeof responseText !== 'string') return undefined;
  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return undefined;
  }
}

export function readHandshakeErrorData(error: unknown): HandshakeErrorData {
  if (typeof error !== 'object' || error === null) {
    throw new Error('Invalid handshake error payload');
  }
  const direct = HandshakeErrorDataSchema.safeParse(Reflect.get(error, 'data'));
  if (direct.success) return direct.data;
  const http = HandshakeErrorDataSchema.safeParse(responseBody(error));
  if (http.success) return http.data;
  throw new Error('Invalid handshake error payload');
}
