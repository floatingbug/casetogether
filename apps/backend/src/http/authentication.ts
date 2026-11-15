import type { PublicUser } from '@casetogether/shared';
import type { Request, RequestHandler } from 'express';
import { ApplicationError } from '../application-error.js';
import type { AuthCookieConfig } from '../config.js';
import type { Authentication, IdentityService } from '../modules/identity/identity-service.js';
import { readAuthCookie } from './auth-cookies.js';

const requestAuthentications = new WeakMap<Request, Authentication>();

export function requireAuthentication(
  identityService: IdentityService,
  cookieConfiguration: AuthCookieConfig,
): RequestHandler {
  return async (request, _response, next) => {
    const cookieValue = readAuthCookie(request.headers.cookie, cookieConfiguration);
    const authentication = await identityService.authenticate(cookieValue);
    requestAuthentications.set(request, authentication);
    next();
  };
}

export function getAuthenticatedUser(request: Request): PublicUser {
  const authentication = requestAuthentications.get(request);
  if (authentication === undefined) {
    throw new ApplicationError('UNAUTHENTICATED', 'Authentication required');
  }
  return authentication.user;
}
