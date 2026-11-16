import { io, type Socket } from 'socket.io-client';

export interface SocketTransportListeners {
  connected(): void;
  disconnected(): void;
  connectionFailed(error: unknown): void;
  applicationEvent(eventName: string, payload: unknown): void;
  unknownEvent(): void;
}

export interface SocketTransport {
  readonly connected: boolean;
  connect(): void;
  disconnect(): void;
  request(eventName: string, payload: unknown, timeoutMs: number): Promise<unknown>;
}

class SocketIoTransport implements SocketTransport {
  constructor(
    private readonly socket: Socket,
    private readonly listeners: SocketTransportListeners,
  ) {
    socket.on('connect', listeners.connected);
    socket.on('disconnect', listeners.disconnected);
    socket.on('connect_error', listeners.connectionFailed);
    socket.onAny((eventName: string, ...args: unknown[]) => {
      if (KNOWN_EVENTS.has(eventName) && args.length === 1) {
        listeners.applicationEvent(eventName, args[0]);
      } else {
        listeners.unknownEvent();
      }
    });
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  connect(): void {
    this.socket.connect();
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  request(eventName: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.socket
        .timeout(timeoutMs)
        .emit(eventName, payload, (error: unknown, response: unknown) => {
          if (error !== null && error !== undefined) {
            reject(new Error('Socket acknowledgement timed out', { cause: error }));
            return;
          }
          resolve(response);
        });
    });
  }
}

export const KNOWN_EVENTS = new Set([
  'room:snapshot',
  'room:presence',
  'room:member-joined',
  'room:member-left',
  'room:closed',
  'room:invitation-rotated',
  'room:started',
  'chat:message',
  'game:snapshot',
  'game:event',
  'game:error',
]);

export function createSocketTransport(listeners: SocketTransportListeners): SocketTransport {
  const socket = io({
    path: '/socket.io',
    withCredentials: true,
    autoConnect: false,
    // Browser same-origin polling can omit Origin, which the server correctly rejects.
    // Use WebSocket from the first handshake; do not fall back to long-polling.
    transports: ['websocket'],
  });
  return new SocketIoTransport(socket, listeners);
}
