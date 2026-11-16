import { describe, expect, it, vi } from 'vitest';
import { createSocketTransport, type SocketTransportListeners } from '../../src/realtime/transport';

const { ioMock } = vi.hoisted(() => ({
  ioMock: vi.fn(() => ({
    on: vi.fn(),
    onAny: vi.fn(),
  })),
}));

vi.mock('socket.io-client', () => ({ io: ioMock }));

const listeners: SocketTransportListeners = {
  connected: vi.fn(),
  disconnected: vi.fn(),
  connectionFailed: vi.fn(),
  applicationEvent: vi.fn(),
  unknownEvent: vi.fn(),
};

describe('Socket.IO browser transport', () => {
  it('starts WebSocket-only because browser long-polling may omit the required Origin', () => {
    createSocketTransport(listeners);

    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledWith({
      path: '/socket.io',
      withCredentials: true,
      autoConnect: false,
      transports: ['websocket'],
    });
  });
});
