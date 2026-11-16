import { HandshakeErrorDataSchema, type HandshakeErrorData } from '@casetogether/shared';
import type { Socket } from 'socket.io-client';

function responseBody(error: Error): unknown {
  const context = Reflect.get(error, 'context');
  if (typeof context !== 'object' || context === null) {
    return undefined;
  }
  const responseText = Reflect.get(context, 'responseText');
  if (typeof responseText !== 'string') {
    return undefined;
  }
  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return undefined;
  }
}

export function readHandshakeErrorData(error: unknown): HandshakeErrorData {
  if (!(error instanceof Error)) {
    throw new Error('Invalid handshake error payload');
  }
  const direct = HandshakeErrorDataSchema.safeParse(Reflect.get(error, 'data'));
  if (direct.success) {
    return direct.data;
  }
  const http = HandshakeErrorDataSchema.safeParse(responseBody(error));
  if (http.success) {
    return http.data;
  }
  throw new Error('Invalid handshake error payload');
}

/**
 * Normalizes Engine.IO's initial long-poll HTTP error into the same validated
 * connect_error.data shape used by Socket.IO's WebSocket CONNECT_ERROR packet.
 */
export function installHandshakeErrorAdapter(socket: Socket): Socket {
  socket.on('connect_error', (error: Error) => {
    try {
      const data = readHandshakeErrorData(error);
      Reflect.set(error, 'data', data);
    } catch {
      // Invalid transport errors stay untouched and are never interpreted by message text.
    }
  });
  return socket;
}
