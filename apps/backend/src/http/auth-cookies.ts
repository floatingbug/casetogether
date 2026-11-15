import type { Response } from 'express';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { AuthCookieConfig } from '../config.js';
import { AUTH_SESSION_TTL_SECONDS } from '../modules/identity/clock.js';

export function readAuthCookie(
  cookieHeader: string | undefined,
  configuration: AuthCookieConfig,
): string | undefined {
  if (cookieHeader === undefined) {
    return undefined;
  }

  const cookies = parseCookie(cookieHeader);
  return cookies[configuration.name];
}

export function setAuthCookie(
  response: Response,
  configuration: AuthCookieConfig,
  cookieValue: string,
  expiresAt: Date,
): void {
  response.setHeader(
    'Set-Cookie',
    stringifySetCookie({
      name: configuration.name,
      value: cookieValue,
      httpOnly: configuration.httpOnly,
      sameSite: configuration.sameSite,
      secure: configuration.secure,
      path: configuration.path,
      expires: expiresAt,
      maxAge: AUTH_SESSION_TTL_SECONDS,
    }),
  );
}

export function clearAuthCookie(response: Response, configuration: AuthCookieConfig): void {
  response.setHeader(
    'Set-Cookie',
    stringifySetCookie({
      name: configuration.name,
      value: '',
      httpOnly: configuration.httpOnly,
      sameSite: configuration.sameSite,
      secure: configuration.secure,
      path: configuration.path,
      expires: new Date(0),
      maxAge: 0,
    }),
  );
}
