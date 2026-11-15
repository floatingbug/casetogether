import type { Request, RequestHandler } from 'express';
import type { IdentityService } from '../modules/identity/identity-service.js';

function requestIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

export function limitAuthRequestsByIp(identityService: IdentityService): RequestHandler {
  return (request, _response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      next();
      return;
    }
    identityService.checkIpRateLimit(requestIp(request));
    next();
  };
}
