import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ErrorResponseSchema, type ErrorResponse, type PublicUser } from '@casetogether/shared';
import { ApplicationError } from '../application-error.js';
import type { AuthCookieConfig } from '../config.js';
import { readAuthCookie } from '../http/auth-cookies.js';
import type { IdentityService } from '../modules/identity/identity-service.js';
import type { InternalErrorLogger } from './errors.js';

export const HANDSHAKE_ERROR_MESSAGE = 'Handshake rejected';

export interface HandshakeSuccess {
  ok: true;
  user: PublicUser;
  cookieValue: string;
}

export interface HandshakeFailure {
  ok: false;
  status: 401 | 403 | 500;
  body: ErrorResponse;
}

export type HandshakeResult = HandshakeSuccess | HandshakeFailure;

export class HandshakeAuthenticator {
  private readonly identityService: IdentityService;
  private readonly cookieConfiguration: AuthCookieConfig;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly logInternalError: InternalErrorLogger;
  private readonly results = new WeakMap<IncomingMessage, HandshakeResult>();

  constructor(options: {
    identityService: IdentityService;
    cookieConfiguration: AuthCookieConfig;
    allowedOrigins: readonly string[];
    logInternalError: InternalErrorLogger;
  }) {
    this.identityService = options.identityService;
    this.cookieConfiguration = options.cookieConfiguration;
    this.allowedOrigins = new Set(options.allowedOrigins);
    this.logInternalError = options.logInternalError;
  }

  async authenticate(request: IncomingMessage): Promise<HandshakeResult> {
    const previous = this.results.get(request);
    if (previous !== undefined) {
      return previous;
    }
    const result = await this.authenticateUncached(request);
    this.results.set(request, result);
    return result;
  }

  async handleEngineRequest(
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): Promise<void> {
    const query = new URL(request.url ?? '/', 'http://socket.local').searchParams;
    const initialRequest = request.method === 'GET' && !query.has('sid');
    if (!initialRequest) {
      next();
      return;
    }

    const result = await this.authenticate(request);
    const websocket = request.headers.upgrade?.toLowerCase() === 'websocket';
    if (!result.ok && !websocket) {
      this.writeHttpError(request, response, result);
      return;
    }
    next();
  }

  asConnectError(failure: HandshakeFailure): Error {
    return Object.assign(new Error(HANDSHAKE_ERROR_MESSAGE), { data: failure.body });
  }

  private async authenticateUncached(request: IncomingMessage): Promise<HandshakeResult> {
    // The exact Origin allowlist is authoritative for the handshake. A cross-site
    // Sec-Fetch-Site is expected for the separately deployed frontend and API (ADR-004), so it
    // must not override an explicitly allowlisted origin.
    const origin = request.headers.origin;
    if (origin === undefined || !this.allowedOrigins.has(origin)) {
      return this.failure(403, 'CSRF_REJECTED', 'Origin or fetch metadata was rejected');
    }

    const cookieValue = readAuthCookie(request.headers.cookie, this.cookieConfiguration);
    try {
      const authentication = await this.identityService.authenticate(cookieValue);
      if (cookieValue === undefined) {
        throw new ApplicationError('UNAUTHENTICATED', 'Authentication required');
      }
      return { ok: true, user: authentication.user, cookieValue };
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'UNAUTHENTICATED') {
        return this.failure(401, 'UNAUTHENTICATED', 'Authentication required');
      }
      const requestId = randomUUID();
      this.logInternalError(requestId);
      return {
        ok: false,
        status: 500,
        body: ErrorResponseSchema.parse({
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId },
        }),
      };
    }
  }

  private failure(
    status: 401 | 403,
    code: 'UNAUTHENTICATED' | 'CSRF_REJECTED',
    message: string,
  ): HandshakeFailure {
    return {
      ok: false,
      status,
      body: ErrorResponseSchema.parse({
        error: { code, message, requestId: randomUUID() },
      }),
    };
  }

  private writeHttpError(
    request: IncomingMessage,
    response: ServerResponse,
    failure: HandshakeFailure,
  ): void {
    const origin = request.headers.origin;
    if (origin !== undefined && this.allowedOrigins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Vary', 'Origin');
    }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.writeHead(failure.status);
    response.end(JSON.stringify(failure.body));
  }
}
