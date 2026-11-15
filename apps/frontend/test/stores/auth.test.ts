import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../src/stores/auth';
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
  setActivePinia(createPinia());
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Pinia auth store', () => {
  it('bootstraps the server PublicUser from GET /me', async () => {
    fetchMock.mockResolvedValue(userResponse());
    const auth = useAuthStore();

    await auth.bootstrap();

    expect(auth.status).toBe('authenticated');
    expect(auth.user).toEqual(testUser);
    expect(auth.hasBootstrapped).toBe(true);
    expect(auth.user).not.toHaveProperty('email');
  });

  it.each([401, 404])(
    'clears all private identity state after bootstrap HTTP %s',
    async (status) => {
      fetchMock.mockResolvedValue(
        errorResponse(status === 401 ? 'UNAUTHENTICATED' : 'NOT_FOUND', status),
      );
      const auth = useAuthStore();
      auth.setUser(testUser);

      await auth.bootstrap(true);

      expect(auth.user).toBeNull();
      expect(auth.isAuthenticated).toBe(false);
      expect(auth.status).toBe('anonymous');
      expect(auth.serverLogoutUnconfirmed).toBe(false);
    },
  );

  it('fails closed without private remnants on other bootstrap errors', async () => {
    fetchMock.mockResolvedValue(errorResponse('INTERNAL_ERROR', 500));
    const auth = useAuthStore();
    auth.setUser(testUser);

    await expect(auth.bootstrap(true)).resolves.toBeUndefined();

    expect(auth.user).toBeNull();
    expect(auth.status).toBe('error');
  });

  it('deduplicates simultaneous bootstrap requests and caches the result', async () => {
    fetchMock.mockResolvedValue(userResponse());
    const auth = useAuthStore();

    await Promise.all([auth.bootstrap(), auth.bootstrap()]);
    await auth.bootstrap();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stores only the returned PublicUser after login', async () => {
    fetchMock.mockResolvedValue(userResponse());
    const auth = useAuthStore();

    await auth.login({ email: 'ada@example.invalid', password: fictionalPassword });

    expect(auth.user).toEqual(testUser);
    expect(Object.keys(auth.$state)).toEqual(
      expect.arrayContaining(['user', 'status', 'hasBootstrapped']),
    );
    expect(JSON.stringify(auth.$state)).not.toContain(fictionalPassword);
  });

  it('stores the registered PublicUser after a 201 response', async () => {
    fetchMock.mockResolvedValue(userResponse(201));
    const auth = useAuthStore();

    await auth.register({
      email: 'ada@example.invalid',
      password: fictionalPassword,
      displayName: 'Ada Test',
    });

    expect(auth.user).toEqual(testUser);
    expect(auth.status).toBe('authenticated');
  });

  it.each([
    [204, true],
    [401, false],
    [404, false],
    [403, false],
    [500, false],
  ])('logout with HTTP %s always clears local auth state', async (status, confirmed) => {
    fetchMock.mockResolvedValue(
      status === 204
        ? emptyResponse()
        : errorResponse(
            status === 401
              ? 'UNAUTHENTICATED'
              : status === 404
                ? 'NOT_FOUND'
                : status === 403
                  ? 'CSRF_REJECTED'
                  : 'INTERNAL_ERROR',
            status,
          ),
    );
    const auth = useAuthStore();
    auth.setUser(testUser);

    await expect(auth.logout()).resolves.toBe(confirmed);

    expect(auth.user).toBeNull();
    expect(auth.status).toBe('anonymous');
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.logoutInProgress).toBe(false);
    expect(auth.serverLogoutUnconfirmed).toBe(!confirmed);
    expect(JSON.stringify(auth.$state)).not.toContain(testUser.id);
  });

  it('clears local auth state after a logout transport failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline fixture'));
    const auth = useAuthStore();
    auth.setUser(testUser);

    await expect(auth.logout()).resolves.toBe(false);
    expect(auth.user).toBeNull();
    expect(auth.serverLogoutUnconfirmed).toBe(true);
  });

  it('does not retain malformed user responses', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: 'bad id', displayName: '' } }));
    const auth = useAuthStore();

    await expect(
      auth.login({ email: 'ada@example.invalid', password: fictionalPassword }),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(auth.user).toBeNull();
    expect(auth.status).toBe('idle');
  });
});
