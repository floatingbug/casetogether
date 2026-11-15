import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthApi } from '../../src/api/auth';
import { ApiClientError } from '../../src/api/http';
import {
  emptyResponse,
  errorResponse,
  fictionalPassword,
  jsonResponse,
  testUser,
  userResponse,
} from '../fixtures';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
});

function requestInit(): RequestInit {
  const init = fetchMock.mock.calls[0]?.[1];
  if (init === undefined) {
    throw new Error('Expected one fetch request');
  }
  return init;
}

describe('typed auth REST client', () => {
  it('logs in with same-origin credentials, JSON and a shared-schema response', async () => {
    fetchMock.mockResolvedValue(userResponse());
    const api = createAuthApi({ fetcher: fetchMock });

    await expect(
      api.login({ email: '  ADA@EXAMPLE.INVALID ', password: fictionalPassword }),
    ).resolves.toEqual(testUser);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/login');
    const init = requestInit();
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('authorization')).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'ada@example.invalid',
      password: fictionalPassword,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toMatch(/token|password|session/i);
  });

  it('registers with normalized shared fields and returns only PublicUser', async () => {
    fetchMock.mockResolvedValue(userResponse(201));
    const api = createAuthApi({ fetcher: fetchMock });

    await expect(
      api.register({
        email: 'ADA@EXAMPLE.INVALID',
        password: fictionalPassword,
        displayName: '  Ada Test  ',
      }),
    ).resolves.toEqual(testUser);

    expect(JSON.parse(String(requestInit().body))).toEqual({
      email: 'ada@example.invalid',
      password: fictionalPassword,
      displayName: 'Ada Test',
    });
    expect(requestInit().credentials).toBe('include');
  });

  it('bootstraps via GET /me with credentials and JSON content type', async () => {
    fetchMock.mockResolvedValue(userResponse());
    const api = createAuthApi({ fetcher: fetchMock });

    await expect(api.getMe()).resolves.toEqual(testUser);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/me');
    expect(requestInit()).toMatchObject({
      method: 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('sends a credentialled, body-less JSON logout and accepts only 204', async () => {
    fetchMock.mockResolvedValue(emptyResponse());
    const api = createAuthApi({ fetcher: fetchMock });

    await expect(api.logout()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/logout');
    expect(requestInit()).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(requestInit().body).toBeUndefined();
    expect(new Headers(requestInit().headers).get('content-type')).toBe('application/json');
  });

  it.each([
    ['VALIDATION_ERROR', 400],
    ['UNAUTHENTICATED', 401],
    ['INVALID_CREDENTIALS', 401],
    ['CSRF_REJECTED', 403],
    ['NOT_FOUND', 404],
    ['EMAIL_ALREADY_REGISTERED', 409],
    ['RATE_LIMITED', 429],
    ['INTERNAL_ERROR', 500],
  ] as const)('maps the server error envelope %s to a typed error', async (code, status) => {
    const details =
      code === 'VALIDATION_ERROR'
        ? { fieldErrors: [{ path: 'email', code: 'invalid_string' }] }
        : code === 'RATE_LIMITED'
          ? { retryAfterSeconds: 30 }
          : undefined;
    fetchMock.mockResolvedValue(
      errorResponse(code, status, 'Server text is not a UI key', details),
    );
    const api = createAuthApi({ fetcher: fetchMock });

    const request = code === 'UNAUTHENTICATED' || code === 'NOT_FOUND' ? api.getMe() : api.logout();
    await expect(request).rejects.toMatchObject({
      name: 'ApiClientError',
      code,
      status,
      requestId: 'request_fixture_1',
    });
  });

  it('rejects malformed success data instead of exposing extra private fields', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { ...testUser, email: 'not-public@example.invalid', token: 'fictional' },
      }),
    );
    const api = createAuthApi({ fetcher: fetchMock });

    await expect(api.getMe()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects malformed error envelopes and non-JSON responses', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'CSRF_REJECTED' } }, 403))
      .mockResolvedValueOnce(
        new Response('not json', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
      );
    const api = createAuthApi({ fetcher: fetchMock });

    await expect(api.logout()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 403 });
    await expect(api.logout()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 500 });
  });

  it('rejects malformed JSON and unexpected successful statuses', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
      .mockResolvedValueOnce(userResponse(202));
    const api = createAuthApi({ fetcher: fetchMock });

    await expect(api.getMe()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(api.getMe()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 202 });
  });

  it('classifies transport failures without leaking the thrown details', async () => {
    fetchMock.mockRejectedValue(new Error('socket details must not become UI text'));
    const api = createAuthApi({ fetcher: fetchMock });

    const request = api.getMe();
    await expect(request).rejects.toBeInstanceOf(ApiClientError);
    await expect(request).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: null });
  });

  it('does not send requests that violate the shared input schema', async () => {
    const api = createAuthApi({ fetcher: fetchMock });

    await expect(api.login({ email: 'not-an-email', password: 'x' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never reads or writes browser token storage, even with auth-like response headers', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const response = userResponse();
    response.headers.set('Authorization', 'Bearer explicit-fictional-test-value');
    fetchMock.mockResolvedValue(response);
    const api = createAuthApi({ fetcher: fetchMock });

    await api.getMe();

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(globalThis.localStorage.length).toBe(0);
    expect(globalThis.sessionStorage.length).toBe(0);
  });
});
