import {
  CatalogQuestionRequestSchema,
  ChatSendAckSchema,
  ChatSendRequestSchema,
  RoomJoinAckSchema,
  RoomJoinRequestSchema,
  RoomLeaveAckSchema,
  RoomLeaveRequestSchema,
  RoomSyncAckSchema,
  RoomSyncRequestSchema,
  SuspectQuestionAckSchema,
  type ApiError,
  type CatalogQuestionRequest,
  type ChatSendAckData,
  type ChatSendRequest,
  type ClientRequestId,
  type ErrorDetails,
  type RoomJoinAckData,
  type RoomJoinRequest,
  type RoomLeaveAckData,
  type RoomLeaveRequest,
  type SuspectQuestionAckData,
} from '@casetogether/shared';
import type { z } from 'zod';
import type { ApiClientErrorCode } from '../api/http';
import { readHandshakeErrorData } from './handshake';
import {
  createSocketTransport,
  type SocketTransport,
  type SocketTransportListeners,
} from './transport';

type WireAck<Data> =
  | { ok: true; data: Data }
  | { ok: false; error: ApiError; clientRequestId?: ClientRequestId | undefined };

export type RealtimeConnectionEvent =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'connection_failed'; error: RealtimeClientError };

export interface RealtimeApplicationEvent {
  eventName: string;
  payload: unknown;
}

export type RealtimeClientErrorCode = ApiClientErrorCode | 'ACK_TIMEOUT' | 'DISCONNECTED';

export class RealtimeClientError extends Error {
  constructor(
    readonly code: RealtimeClientErrorCode,
    message: string,
    readonly options: {
      confirmed: boolean;
      requestId?: string;
      clientRequestId?: ClientRequestId;
      details?: ErrorDetails;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'RealtimeClientError';
  }
}

export interface RealtimeClient {
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): void;
  joinRoom(request: RoomJoinRequest): Promise<RoomJoinAckData>;
  syncRoom(request: RoomJoinRequest): Promise<RoomJoinAckData>;
  leaveRoom(request: RoomLeaveRequest): Promise<RoomLeaveAckData>;
  sendChat(request: ChatSendRequest): Promise<ChatSendAckData>;
  askCatalog(request: CatalogQuestionRequest): Promise<SuspectQuestionAckData>;
  subscribeConnection(listener: (event: RealtimeConnectionEvent) => void): () => void;
  subscribeEvents(listener: (event: RealtimeApplicationEvent) => void): () => void;
}

interface RealtimeClientOptions {
  transport?: SocketTransport;
  transportFactory?: (listeners: SocketTransportListeners) => SocketTransport;
  ackTimeoutMs?: number;
}

function normalizedConnectionError(error: unknown): RealtimeClientError {
  try {
    const data = readHandshakeErrorData(error);
    return apiAckError(data.error);
  } catch (normalizationError: unknown) {
    return new RealtimeClientError('NETWORK_ERROR', 'The realtime connection failed', {
      confirmed: false,
      cause: normalizationError,
    });
  }
}

function apiAckError(error: ApiError, clientRequestId?: ClientRequestId): RealtimeClientError {
  return new RealtimeClientError(error.code, error.message, {
    confirmed: true,
    requestId: error.requestId,
    ...(clientRequestId === undefined ? {} : { clientRequestId }),
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}

export function createRealtimeClient(options: RealtimeClientOptions = {}): RealtimeClient {
  const connectionListeners = new Set<(event: RealtimeConnectionEvent) => void>();
  const eventListeners = new Set<(event: RealtimeApplicationEvent) => void>();
  const ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
  let connectionAttempt: Promise<void> | null = null;

  const notifyConnection = (event: RealtimeConnectionEvent): void => {
    for (const listener of connectionListeners) listener(event);
  };

  const transportListeners: SocketTransportListeners = {
    connected: () => notifyConnection({ type: 'connected' }),
    disconnected: () => notifyConnection({ type: 'disconnected' }),
    connectionFailed: (error) =>
      notifyConnection({ type: 'connection_failed', error: normalizedConnectionError(error) }),
    applicationEvent: (eventName, payload) => {
      for (const listener of eventListeners) listener({ eventName, payload });
    },
    unknownEvent: () => {
      for (const listener of eventListeners) listener({ eventName: '', payload: undefined });
    },
  };
  const transport =
    options.transport ?? (options.transportFactory ?? createSocketTransport)(transportListeners);

  async function request<Request, Data>(configuration: {
    eventName: string;
    payload: Request;
    requestSchema: z.ZodType<Request>;
    ackSchema: z.ZodType<WireAck<Data>>;
    clientRequestId?: ClientRequestId;
  }): Promise<Data> {
    const parsedRequest = configuration.requestSchema.safeParse(configuration.payload);
    if (!parsedRequest.success) {
      throw new RealtimeClientError('INVALID_REQUEST', 'The socket request is invalid', {
        confirmed: true,
        ...(configuration.clientRequestId === undefined
          ? {}
          : { clientRequestId: configuration.clientRequestId }),
        cause: parsedRequest.error,
      });
    }

    let rawAck: unknown;
    try {
      rawAck = await transport.request(configuration.eventName, parsedRequest.data, ackTimeoutMs);
    } catch (error: unknown) {
      throw new RealtimeClientError('ACK_TIMEOUT', 'The acknowledgement outcome is unknown', {
        confirmed: false,
        ...(configuration.clientRequestId === undefined
          ? {}
          : { clientRequestId: configuration.clientRequestId }),
        cause: error,
      });
    }

    const parsedAck = configuration.ackSchema.safeParse(rawAck);
    if (!parsedAck.success) {
      throw new RealtimeClientError('INVALID_RESPONSE', 'The socket acknowledgement is invalid', {
        confirmed: false,
        ...(configuration.clientRequestId === undefined
          ? {}
          : { clientRequestId: configuration.clientRequestId }),
        cause: parsedAck.error,
      });
    }
    if (!parsedAck.data.ok) {
      throw apiAckError(parsedAck.data.error, parsedAck.data.clientRequestId);
    }
    return parsedAck.data.data;
  }

  return {
    get connected() {
      return transport.connected;
    },

    connect() {
      if (transport.connected) {
        queueMicrotask(() => notifyConnection({ type: 'connected' }));
        return Promise.resolve();
      }
      if (connectionAttempt !== null) return connectionAttempt;

      connectionAttempt = new Promise<void>((resolve, reject) => {
        const unsubscribe = subscribeConnection((event) => {
          if (event.type === 'connected') {
            unsubscribe();
            connectionAttempt = null;
            resolve();
          } else if (event.type === 'connection_failed') {
            unsubscribe();
            connectionAttempt = null;
            reject(event.error);
          }
        });
        transport.connect();
      });
      return connectionAttempt;
    },

    disconnect() {
      connectionAttempt = null;
      transport.disconnect();
    },

    async joinRoom(requestPayload) {
      return request({
        eventName: 'room:join',
        payload: requestPayload,
        requestSchema: RoomJoinRequestSchema,
        ackSchema: RoomJoinAckSchema,
      });
    },

    async syncRoom(requestPayload) {
      return request({
        eventName: 'room:sync',
        payload: requestPayload,
        requestSchema: RoomSyncRequestSchema,
        ackSchema: RoomSyncAckSchema,
      });
    },

    async leaveRoom(requestPayload) {
      return request({
        eventName: 'room:leave',
        payload: requestPayload,
        requestSchema: RoomLeaveRequestSchema,
        ackSchema: RoomLeaveAckSchema,
        clientRequestId: requestPayload.clientRequestId,
      });
    },

    async sendChat(requestPayload) {
      return request({
        eventName: 'chat:send',
        payload: requestPayload,
        requestSchema: ChatSendRequestSchema,
        ackSchema: ChatSendAckSchema,
        clientRequestId: requestPayload.clientRequestId,
      });
    },

    async askCatalog(requestPayload) {
      return request({
        eventName: 'suspect:question',
        payload: requestPayload,
        requestSchema: CatalogQuestionRequestSchema,
        ackSchema: SuspectQuestionAckSchema,
        clientRequestId: requestPayload.clientRequestId,
      });
    },

    subscribeConnection(listener) {
      return subscribeConnection(listener);
    },

    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };

  function subscribeConnection(listener: (event: RealtimeConnectionEvent) => void): () => void {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  }
}

export const realtimeClient = createRealtimeClient();
