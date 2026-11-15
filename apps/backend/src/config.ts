import type { CookieOptions } from 'express';

export const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:5173';
export const AUTH_COOKIE_NAME = 'ct_session';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface BackendConfig {
  nodeEnv: NodeEnvironment;
  port: number;
  allowedOrigins: readonly string[];
  authCookie: CookieOptions & { name: typeof AUTH_COOKIE_NAME };
}

export function parseAllowedOrigins(value: string): readonly string[] {
  const origins = value.split(',').map((origin) => origin.trim());
  if (origins.length === 0 || origins.some((origin) => origin.length === 0)) {
    throw new Error('FRONTEND_ORIGIN must contain at least one exact origin');
  }

  return origins.map((origin) => {
    if (origin === '*') {
      throw new Error('Credentialed CORS must never use a wildcard origin');
    }
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error(
        'FRONTEND_ORIGIN entries must be exact HTTP(S) origins without paths or credentials',
      );
    }
    return url.origin;
  });
}

function readNodeEnvironment(value: string | undefined): NodeEnvironment {
  if (value === undefined || value === '') {
    return 'development';
  }
  if (value === 'development' || value === 'test' || value === 'production') {
    return value;
  }
  throw new Error('NODE_ENV must be development, test or production');
}

function readPort(value: string | undefined): number {
  if (value === undefined || value === '') {
    return 3000;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return port;
}

export function readBackendConfig(environment: NodeJS.ProcessEnv = process.env): BackendConfig {
  const nodeEnv = readNodeEnvironment(environment['NODE_ENV']);
  return {
    nodeEnv,
    port: readPort(environment['PORT']),
    allowedOrigins: parseAllowedOrigins(environment['FRONTEND_ORIGIN'] ?? DEFAULT_FRONTEND_ORIGIN),
    authCookie: {
      name: AUTH_COOKIE_NAME,
      httpOnly: true,
      sameSite: 'lax',
      secure: nodeEnv === 'production',
      path: '/',
    },
  };
}
