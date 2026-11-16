import {
  CaseListResponseSchema,
  FinalSubmissionRequestSchema,
  GameResponseSchema,
  RoomIdSchema,
  SessionIdSchema,
  StartGameRequestSchema,
} from '@casetogether/shared';
import { Router } from 'express';
import type { AuthCookieConfig } from '../../config.js';
import type { GameSessionService } from '../../modules/game-sessions/game-session-service.js';
import type { IdentityService } from '../../modules/identity/identity-service.js';
import { getAuthenticatedUser, requireAuthentication } from '../authentication.js';
import { validationError } from '../validation.js';

export function createGameSessionRoutes(
  identityService: IdentityService,
  gameSessionService: GameSessionService,
  cookieConfiguration: AuthCookieConfig,
): Router {
  const router = Router();
  const authenticated = requireAuthentication(identityService, cookieConfiguration);

  router.get('/cases', authenticated, async (_request, response) => {
    const data = await gameSessionService.listCases();
    response.status(200).json(CaseListResponseSchema.parse({ data }));
  });

  router.post('/rooms/:roomId/start', authenticated, async (request, response) => {
    const roomId = RoomIdSchema.safeParse(request.params['roomId']);
    const body = StartGameRequestSchema.safeParse(request.body as unknown);
    if (!roomId.success) {
      throw validationError(roomId.error);
    }
    if (!body.success) {
      throw validationError(body.error);
    }
    const result = await gameSessionService.startGame(
      getAuthenticatedUser(request),
      roomId.data,
      body.data,
    );
    response.status(200).json(GameResponseSchema.parse({ data: result.data }));
  });

  router.get('/sessions/:sessionId', authenticated, async (request, response) => {
    const sessionId = SessionIdSchema.safeParse(request.params['sessionId']);
    if (!sessionId.success) {
      throw validationError(sessionId.error);
    }
    const data = await gameSessionService.getSession(getAuthenticatedUser(request), sessionId.data);
    response.status(200).json(GameResponseSchema.parse({ data }));
  });

  router.post('/sessions/:sessionId/final-submission', authenticated, async (request, response) => {
    const sessionId = SessionIdSchema.safeParse(request.params['sessionId']);
    const body = FinalSubmissionRequestSchema.safeParse(request.body as unknown);
    if (!sessionId.success) {
      throw validationError(sessionId.error);
    }
    if (!body.success) {
      throw validationError(body.error);
    }
    const result = await gameSessionService.submitFinalSolution(
      getAuthenticatedUser(request),
      sessionId.data,
      body.data,
    );
    response.status(200).json(GameResponseSchema.parse({ data: result.data }));
  });

  return router;
}
