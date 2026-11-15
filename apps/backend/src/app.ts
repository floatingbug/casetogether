import { randomUUID } from 'node:crypto';
import {
  ErrorResponseSchema,
  HealthResponseSchema,
  ReadinessResponseSchema,
  type ErrorCode,
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
import { DEFAULT_FRONTEND_ORIGIN, parseAllowedOrigins, type NodeEnvironment } from './config.js';

export const JSON_PAYLOAD_LIMIT = '16kb';
export type MongoDbStatus = 'up' | 'down';

export interface AppOptions {
  allowedOrigins?: readonly string[];
  nodeEnv?: NodeEnvironment;
  mongoDbStatus?: () => Promise<MongoDbStatus>;
}

function sendError(response: Response, status: number, code: ErrorCode, message: string): void {
  const body = ErrorResponseSchema.parse({
    error: {
      code,
      message,
      requestId: randomUUID(),
    },
  });
  response.status(status).json(body);
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

const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
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
  sendError(response, 500, 'INTERNAL_ERROR', 'Internal server error');
};

const unavailableMongoDb = async (): Promise<MongoDbStatus> => 'down';

export function createApp(options: AppOptions = {}): Express {
  const allowedOrigins = new Set(
    parseAllowedOrigins((options.allowedOrigins ?? [DEFAULT_FRONTEND_ORIGIN]).join(',')),
  );
  const mongoDbStatus = options.mongoDbStatus ?? unavailableMongoDb;
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
      ...(options.nodeEnv === 'production' ? {} : { strictTransportSecurity: false }),
    }),
  );
  app.use(cors(createCorsOptions(allowedOrigins)));
  app.use(createOriginProtection(allowedOrigins));
  app.use(express.json({ limit: JSON_PAYLOAD_LIMIT, strict: true }));

  app.get('/api/v1/health', (_request, response) => {
    response.status(200).json(HealthResponseSchema.parse({ data: { status: 'ok' } }));
  });

  app.get('/api/v1/ready', async (_request, response) => {
    let mongodb: MongoDbStatus;
    try {
      mongodb = await mongoDbStatus();
    } catch {
      // A failed required dependency is not ready; internals never enter the response.
      mongodb = 'down';
    }

    const data = {
      status: mongodb === 'up' ? ('ready' as const) : ('not_ready' as const),
      checks: { mongodb },
    };
    const body = ReadinessResponseSchema.parse({ data });
    response.status(mongodb === 'up' ? 200 : 503).json(body);
  });

  app.use((_request, response) => {
    sendError(response, 404, 'NOT_FOUND', 'Resource not found');
  });
  app.use(errorHandler);

  return app;
}
