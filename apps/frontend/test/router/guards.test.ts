import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createAppRouter } from '../../src/router';
import { redirectAfterLogin, safeInternalPath } from '../../src/router/navigation';
import { useAuthStore } from '../../src/stores/auth';
import { errorResponse, testUser, userResponse } from '../fixtures';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  setActivePinia(createPinia());
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('router authentication guards', () => {
  it.each([401, 404])(
    'redirects protected navigation to login after GET /me HTTP %s',
    async (status) => {
      fetchMock.mockResolvedValue(
        errorResponse(status === 401 ? 'UNAUTHENTICATED' : 'NOT_FOUND', status),
      );
      const router = createAppRouter(createMemoryHistory());

      await router.push('/');
      await router.isReady();

      expect(router.currentRoute.value.name).toBe('login');
      expect(router.currentRoute.value.query).toEqual({ redirect: '/' });
      expect(useAuthStore().user).toBeNull();
    },
  );

  it('allows guests to use login and registration routes', async () => {
    fetchMock.mockResolvedValue(errorResponse('UNAUTHENTICATED', 401));
    const router = createAppRouter(createMemoryHistory());

    await router.push('/login');
    await router.push('/register');

    expect(router.currentRoute.value.name).toBe('register');
  });

  it('keeps a server-authenticated user on the protected lobby', async () => {
    fetchMock.mockResolvedValue(userResponse());
    const router = createAppRouter(createMemoryHistory());

    await router.push('/');
    await router.isReady();

    expect(router.currentRoute.value.name).toBe('lobby');
    expect(useAuthStore().user).toEqual(testUser);
  });

  it('redirects authenticated users away from guest-only forms', async () => {
    fetchMock.mockResolvedValue(userResponse());
    const router = createAppRouter(createMemoryHistory());

    await router.push('/register');

    expect(router.currentRoute.value.name).toBe('lobby');
  });

  it('forwards an authenticated user to a safe originally requested path', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse('UNAUTHENTICATED', 401));
    const router = createAppRouter(createMemoryHistory());
    await router.push('/login?redirect=%2F%3Ffrom%3Dprivate');
    useAuthStore().setUser(testUser);

    await router.push(redirectAfterLogin(router.currentRoute.value.query['redirect']));

    expect(router.currentRoute.value.fullPath).toBe('/?from=private');
  });
});

describe('safe login redirect targets', () => {
  it.each([
    [undefined, '/'],
    ['', '/'],
    ['https://attacker.invalid', '/'],
    ['//attacker.invalid', '/'],
    ['\\attacker.invalid', '/'],
    ['/\\attacker.invalid', '/'],
    ['/\u0000secret', '/'],
    [['/', '/register'], '/'],
    ['/lobby', '/lobby'],
  ])('sanitizes redirect input %j without accepting external URLs', (input, expected) => {
    expect(safeInternalPath(input)).toBe(expected);
  });

  it('rejects arrays as redirect query values', () => {
    expect(redirectAfterLogin(['/', '/register'])).toBe('/');
  });
});
