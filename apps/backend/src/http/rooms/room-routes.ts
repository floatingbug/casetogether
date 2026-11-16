import {
  ClientRequestSchema,
  CreateRoomResponseEnvelopeSchema,
  JoinRoomRequestSchema,
  RoomIdSchema,
  RoomResponseSchema,
  RotateInvitationRequestSchema,
  RotateInvitationResponseEnvelopeSchema,
} from '@casetogether/shared';
import { Router } from 'express';
import type { AuthCookieConfig } from '../../config.js';
import type { IdentityService } from '../../modules/identity/identity-service.js';
import type { RoomService } from '../../modules/rooms/room-service.js';
import { getAuthenticatedUser, requireAuthentication } from '../authentication.js';
import { validationError } from '../validation.js';

export function createRoomRoutes(
  identityService: IdentityService,
  roomService: RoomService,
  cookieConfiguration: AuthCookieConfig,
  publishRoomPublication?: (publication: unknown) => Promise<void>,
): Router {
  const router = Router();
  const authenticated = requireAuthentication(identityService, cookieConfiguration);

  router.post('/rooms', authenticated, async (request, response) => {
    const body: unknown = request.body;
    const parsed = ClientRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(parsed.error);
    }
    const result = await roomService.createRoom(getAuthenticatedUser(request), parsed.data);
    const status = result.data.outcome === 'created' ? 201 : 200;
    response.status(status).json(CreateRoomResponseEnvelopeSchema.parse({ data: result.data }));
  });

  router.post('/rooms/join', authenticated, async (request, response) => {
    const body: unknown = request.body;
    const parsed = JoinRoomRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(parsed.error);
    }
    roomService.consumeJoinIpRateLimit(request.ip ?? 'unknown');
    const result = await roomService.joinRoom(getAuthenticatedUser(request), parsed.data);
    await publishRoomPublication?.(result.publication);
    response.status(200).json(RoomResponseSchema.parse({ data: result.data }));
  });

  router.get('/rooms/:roomId', authenticated, async (request, response) => {
    const parsed = RoomIdSchema.safeParse(request.params['roomId']);
    if (!parsed.success) {
      throw validationError(parsed.error);
    }
    const snapshot = await roomService.getRoom(getAuthenticatedUser(request), parsed.data);
    response.status(200).json(RoomResponseSchema.parse({ data: snapshot }));
  });

  router.post('/rooms/:roomId/invitation/rotate', authenticated, async (request, response) => {
    const roomId = RoomIdSchema.safeParse(request.params['roomId']);
    if (!roomId.success) {
      throw validationError(roomId.error);
    }
    const body: unknown = request.body;
    const parsed = RotateInvitationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(parsed.error);
    }
    const result = await roomService.rotateInvitation(
      getAuthenticatedUser(request),
      roomId.data,
      parsed.data,
    );
    await publishRoomPublication?.(result.publication);
    response.status(200).json(RotateInvitationResponseEnvelopeSchema.parse({ data: result.data }));
  });

  return router;
}
