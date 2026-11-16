import { randomUUID } from 'node:crypto';
import {
  ErrorResponseSchema,
  HealthResponseSchema,
  ReadinessResponseSchema,
  type ErrorCode,
  type ErrorDetails,
} from '@casetogether/shared';
import cors, { type CorsOptions } from 'cors';
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import helmet from 'helmet';
import { ApplicationError } from './application-error.js';
import {
  DEFAULT_FRONTEND_ORIGIN,
  parseAllowedOrigins,
  readBackendConfig,
  type NodeEnvironment,
} from './config.js';
import type { MongoDbStatus } from './database/mongodb.js';
import { limitAuthRequestsByIp } from './http/auth-rate-limit.js';
import { readAuthCookie } from './http/auth-cookies.js';
import { createIdentityRoutes } from './http/identity-routes.js';
import { createRoomRoutes } from './http/rooms/room-routes.js';
import type { IdentityService } from './modules/identity/identity-service.js';
import type { RoomService } from './modules/rooms/room-service.js';
import type { RealtimeGateway } from './realtime/gateway.js';

export const JSON_PAYLOAD_LIMIT = '16kb';
export type { MongoDbStatus } from './database/mongodb.js';

export interface AppOptions {
  allowedOrigins?: readonly string[];
  nodeEnv?: NodeEnvironment;
  mongoDbStatus?: () => Promise<MongoDbStatus>;
  identityService?: IdentityService;
  roomService?: RoomService;
  realtimeGateway?: Pick<RealtimeGateway, 'publishRoomPublication' | 'disconnectSession'>;
  logInternalError?: (requestId: string) => void;
}

function sendError(
  response: Response,
  status: number,
  code: ErrorCode,
  message: string,
  details?: ErrorDetails,
): string {
  const requestId = randomUUID();
  const body = ErrorResponseSchema.parse({
    error: {
      code,
      message,
      requestId,
      ...(details === undefined ? {} : { details }),
    },
  });
  if (details?.retryAfterSeconds !== undefined) {
    response.setHeader('Retry-After', String(details.retryAfterSeconds));
  }
  response.status(status).json(body);
  return requestId;
}

function createCorsOptions(allowedOrigins: ReadonlySet<string>): CorsOptions {
  return {
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    optionsSuccessStatus: 204,
    origin: (origin, callback) => {
      callback(null, origin === undefined || allowedOrigins.has(origin));
    },
  };
}

function hasRequestBody(request: Request): boolean {
  const contentLength = request.headers['content-length'];
  return (
    request.headers['transfer-encoding'] !== undefined ||
    (contentLength !== undefined && Number(contentLength) > 0)
  );
}

function createOriginProtection(allowedOrigins: ReadonlySet<string>): RequestHandler {
  return (request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      next();
      return;
    }

    const origin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    if (
      origin === undefined ||
      !allowedOrigins.has(origin) ||
      (typeof fetchSite === 'string' && fetchSite.toLowerCase() === 'cross-site')
    ) {
      sendError(response, 403, 'CSRF_REJECTED', 'Origin or fetch metadata was rejected');
      return;
    }
    if (hasRequestBody(request) && request.is('application/json') !== 'application/json') {
      sendError(response, 403, 'CSRF_REJECTED', 'A JSON request body is required');
      return;
    }
    next();
  };
}

function errorProperty(error: unknown, property: string): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  return Reflect.get(error, property);
}

const statusByErrorCode: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  CSRF_REJECTED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  EMAIL_ALREADY_REGISTERED: 409,
  INVITATION_INVALID: 400,
  ROOM_FULL: 409,
  ROOM_NOT_JOINABLE: 409,
  ROOM_CLOSED: 410,
  QUESTION_NOT_AVAILABLE: 409,
  INVALID_STATE_TRANSITION: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  OPERATION_IN_PROGRESS: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  AI_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

function createErrorHandler(logInternalError: (requestId: string) => void): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (
      errorProperty(error, 'status') === 413 ||
      errorProperty(error, 'type') === 'entity.too.large'
    ) {
      sendError(response, 413, 'PAYLOAD_TOO_LARGE', 'JSON payload exceeds the 16 KiB limit');
      return;
    }
    if (error instanceof SyntaxError && errorProperty(error, 'status') === 400) {
      sendError(response, 400, 'VALIDATION_ERROR', 'Malformed JSON request body');
      return;
    }
    if (error instanceof ApplicationError && error.code !== 'INTERNAL_ERROR') {
      sendError(response, statusByErrorCode[error.code], error.code, error.message, error.details);
      return;
    }

    const requestId = sendError(response, 500, 'INTERNAL_ERROR', 'Internal server error');
    logInternalError(requestId);
  };
}

const unavailableMongoDb = async (): Promise<MongoDbStatus> => 'down';

export function createApp(options: AppOptions = {}): Express {
  const allowedOrigins = new Set(
    parseAllowedOrigins((options.allowedOrigins ?? [DEFAULT_FRONTEND_ORIGIN]).join(',')),
  );
  const mongoDbStatus = options.mongoDbStatus ?? unavailableMongoDb;
  const nodeEnv = options.nodeEnv ?? 'development';
  const logInternalError =
    options.logInternalError ??
    ((requestId: string) => {
      console.error(JSON.stringify({ event: 'request_failed', code: 'INTERNAL_ERROR', requestId }));
    });
  const app = express();

  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'none'"],
          connectSrc: ["'none'"],
          fontSrc: ["'none'"],
          formAction: ["'none'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'none'"],
          objectSrc: ["'none'"],
          scriptSrc: ["'none'"],
          styleSrc: ["'none'"],
        },
      },
      ...(nodeEnv === 'production' ? {} : { strictTransportSecurity: false }),
    }),
  );
  app.use(cors(createCorsOptions(allowedOrigins)));
  app.use(createOriginProtection(allowedOrigins));
  if (options.identityService !== undefined) {
    app.use('/api/v1/auth', limitAuthRequestsByIp(options.identityService));
  }
  app.use(express.json({ limit: JSON_PAYLOAD_LIMIT, strict: true }));

  app.get('/api/v1/health', (_request, response) => {
    response.status(200).json(HealthResponseSchema.parse({ data: { status: 'ok' } }));
  });

  app.get('/api/v1/ready', async (_request, response) => {
    let mongodb: MongoDbStatus;
    try {
      mongodb = await mongoDbStatus();
    } catch {
      mongodb = 'down';
    }

    const data = {
      status: mongodb === 'up' ? ('ready' as const) : ('not_ready' as const),
      checks: { mongodb },
    };
    const body = ReadinessResponseSchema.parse({ data });
    response.status(mongodb === 'up' ? 200 : 503).json(body);
  });

  if (options.identityService !== undefined) {
    const cookieConfiguration = readBackendConfig({ NODE_ENV: nodeEnv }).authCookie;
    if (options.realtimeGateway !== undefined) {
      const realtimeGateway = options.realtimeGateway;
      app.use('/api/v1/auth/logout', (request, response, next) => {
        if (request.method === 'POST') {
          const cookieValue = readAuthCookie(request.headers.cookie, cookieConfiguration);
          response.once('finish', () => realtimeGateway.disconnectSession(cookieValue));
        }
        next();
      });
    }
    app.use('/api/v1', createIdentityRoutes(options.identityService, cookieConfiguration));
    if (options.roomService !== undefined) {
      const publishRoomPublication =
        options.realtimeGateway === undefined
          ? undefined
          : (publication: unknown) =>
              options.realtimeGateway?.publishRoomPublication(publication) ?? Promise.resolve();
      app.use(
        '/api/v1',
        createRoomRoutes(
          options.identityService,
          options.roomService,
          cookieConfiguration,
          publishRoomPublication,
        ),
      );
    }
  } else if (options.roomService !== undefined) {
    throw new Error('Room routes require the identity service');
  }

  app.use((_request, response) => {
    sendError(response, 404, 'NOT_FOUND', 'Resource not found');
  });
  app.use(createErrorHandler(logInternalError));

  return app;
}
