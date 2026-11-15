import {
  LoginRequestSchema,
  RegisterRequestSchema,
  UserResponseSchema,
} from '@casetogether/shared';
import { Router } from 'express';
import type { AuthCookieConfig } from '../config.js';
import type { IdentityService } from '../modules/identity/identity-service.js';
import { clearAuthCookie, readAuthCookie, setAuthCookie } from './auth-cookies.js';
import { getAuthenticatedUser, requireAuthentication } from './authentication.js';
import { validationError } from './validation.js';

export function createIdentityRoutes(
  identityService: IdentityService,
  cookieConfiguration: AuthCookieConfig,
): Router {
  const router = Router();

  router.post('/auth/register', async (request, response) => {
    const body: unknown = request.body;
    const parsed = RegisterRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(parsed.error);
    }

    const authentication = await identityService.register(parsed.data);
    setAuthCookie(
      response,
      cookieConfiguration,
      authentication.cookieValue,
      authentication.expiresAt,
    );
    response.status(201).json(UserResponseSchema.parse({ data: authentication.user }));
  });

  router.post('/auth/login', async (request, response) => {
    const body: unknown = request.body;
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(parsed.error);
    }

    const authentication = await identityService.login(parsed.data);
    setAuthCookie(
      response,
      cookieConfiguration,
      authentication.cookieValue,
      authentication.expiresAt,
    );
    response.status(200).json(UserResponseSchema.parse({ data: authentication.user }));
  });

  router.post('/auth/logout', async (request, response) => {
    const cookieValue = readAuthCookie(request.headers.cookie, cookieConfiguration);
    await identityService.logout(cookieValue);
    clearAuthCookie(response, cookieConfiguration);
    response.status(204).end();
  });

  router.get(
    '/me',
    requireAuthentication(identityService, cookieConfiguration),
    (request, response) => {
      response.status(200).json(UserResponseSchema.parse({ data: getAuthenticatedUser(request) }));
    },
  );

  return router;
}
