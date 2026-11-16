import {
  ClientRequestSchema,
  CreateRoomResponseEnvelopeSchema,
  GameResponseSchema,
  JoinRoomRequestSchema,
  RotateInvitationResponseEnvelopeSchema,
  RotateInvitationRequestSchema,
  RoomResponseSchema,
  StartGameRequestSchema,
  type ClientRequest,
  type CreateRoomResponse,
  type GameSnapshot,
  type JoinRoomRequest,
  type RotateInvitationRequest,
  type RotateInvitationResponse,
  type RoomSnapshot,
  type StartGameRequest,
} from '@casetogether/shared';
import { requestData } from './http';

export interface RoomsApi {
  createRoom(request: ClientRequest): Promise<CreateRoomResponse>;
  joinRoom(request: JoinRoomRequest): Promise<RoomSnapshot>;
  getRoom(roomId: string): Promise<RoomSnapshot>;
  rotateInvitation(
    request: RotateInvitationRequest & { roomId: string },
  ): Promise<RotateInvitationResponse>;
  startGame(request: StartGameRequest & { roomId: string }): Promise<GameSnapshot>;
}

export function createRoomsApi(options: { fetcher?: typeof fetch } = {}): RoomsApi {
  return {
    async createRoom(request) {
      const response = await requestData(
        {
          method: 'POST',
          path: '/rooms',
          expectedStatuses: [200, 201],
          body: request,
          requestSchema: ClientRequestSchema,
          responseSchema: CreateRoomResponseEnvelopeSchema,
        },
        options,
      );
      return response.data;
    },

    async joinRoom(request) {
      const response = await requestData(
        {
          method: 'POST',
          path: '/rooms/join',
          expectedStatuses: [200],
          body: request,
          requestSchema: JoinRoomRequestSchema,
          responseSchema: RoomResponseSchema,
        },
        options,
      );
      return response.data;
    },

    async getRoom(roomId) {
      const response = await requestData(
        {
          method: 'GET',
          path: `/rooms/${encodeURIComponent(roomId)}`,
          expectedStatuses: [200],
          responseSchema: RoomResponseSchema,
        },
        options,
      );
      return response.data;
    },

    async rotateInvitation({ roomId, ...request }) {
      const response = await requestData(
        {
          method: 'POST',
          path: `/rooms/${encodeURIComponent(roomId)}/invitation/rotate`,
          expectedStatuses: [200],
          body: request,
          requestSchema: RotateInvitationRequestSchema,
          responseSchema: RotateInvitationResponseEnvelopeSchema,
        },
        options,
      );
      return response.data;
    },

    async startGame({ roomId, ...request }) {
      const response = await requestData(
        {
          method: 'POST',
          path: `/rooms/${encodeURIComponent(roomId)}/start`,
          expectedStatuses: [200],
          body: request,
          requestSchema: StartGameRequestSchema,
          responseSchema: GameResponseSchema,
        },
        options,
      );
      return response.data;
    },
  };
}

export const roomsApi = createRoomsApi();
