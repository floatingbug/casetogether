import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketTransportListeners } from '../../src/realtime/transport';

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

const socketOptions = {
  path: '/socket.io',
  withCredentials: true,
  autoConnect: false,
  transports: ['websocket'],
};

async function createTransportWithOrigin(origin: string): Promise<void> {
  vi.resetModules();
  vi.doMock('../../src/config/api-origin', () => ({ API_ORIGIN: origin }));
  const { createSocketTransport } = await import('../../src/realtime/transport');
  createSocketTransport(listeners);
}

beforeEach(() => {
  ioMock.mockClear();
});

describe('Socket.IO browser transport', () => {
  it('starts WebSocket-only because browser long-polling may omit the required Origin', async () => {
    await createTransportWithOrigin('');

    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledWith(undefined, socketOptions);
  });

  it('connects to the build-time backend origin when one is configured', async () => {
    await createTransportWithOrigin('https://api.casetogether.tasse-voll-code.de');

    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledWith(
      'https://api.casetogether.tasse-voll-code.de',
      socketOptions,
    );
  });
});
