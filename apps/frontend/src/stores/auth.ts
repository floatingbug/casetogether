import type { LoginRequest, PublicUser, RegisterRequest } from '@casetogether/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiClientError } from '../api/http';
import { authApi } from '../api/auth';

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'anonymous' | 'error';

function isMissingSession(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    (error.code === 'UNAUTHENTICATED' || error.code === 'NOT_FOUND')
  );
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<PublicUser | null>(null);
  const status = ref<AuthStatus>('idle');
  const hasBootstrapped = ref(false);
  const logoutInProgress = ref(false);
  const serverLogoutUnconfirmed = ref(false);
  let pendingBootstrap: Promise<void> | null = null;

  const isAuthenticated = computed(() => user.value !== null);

  function setUser(nextUser: PublicUser): void {
    user.value = nextUser;
    status.value = 'authenticated';
    hasBootstrapped.value = true;
    serverLogoutUnconfirmed.value = false;
  }

  function clearPrivateState(): void {
    user.value = null;
    status.value = 'anonymous';
    hasBootstrapped.value = true;
    serverLogoutUnconfirmed.value = false;
  }

  async function bootstrap(force = false): Promise<void> {
    if (pendingBootstrap !== null) {
      return pendingBootstrap;
    }
    if (hasBootstrapped.value && !force) {
      return;
    }

    status.value = 'loading';
    pendingBootstrap = (async () => {
      try {
        setUser(await authApi.getMe());
      } catch (error: unknown) {
        if (isMissingSession(error)) {
          clearPrivateState();
        } else {
          user.value = null;
          status.value = 'error';
          hasBootstrapped.value = true;
          serverLogoutUnconfirmed.value = false;
        }
      } finally {
        pendingBootstrap = null;
      }
    })();

    return pendingBootstrap;
  }

  async function login(request: LoginRequest): Promise<PublicUser> {
    const authenticatedUser = await authApi.login(request);
    setUser(authenticatedUser);
    return authenticatedUser;
  }

  async function register(request: RegisterRequest): Promise<PublicUser> {
    const registeredUser = await authApi.register(request);
    setUser(registeredUser);
    return registeredUser;
  }

  async function logout(): Promise<boolean> {
    if (logoutInProgress.value) {
      return false;
    }

    logoutInProgress.value = true;
    let serverConfirmed = true;
    try {
      await authApi.logout();
    } catch {
      serverConfirmed = false;
    } finally {
      clearPrivateState();
      serverLogoutUnconfirmed.value = !serverConfirmed;
      logoutInProgress.value = false;
    }
    return serverConfirmed;
  }

  return {
    user,
    status,
    hasBootstrapped,
    isAuthenticated,
    logoutInProgress,
    serverLogoutUnconfirmed,
    bootstrap,
    setUser,
    clearPrivateState,
    login,
    register,
    logout,
  };
});
