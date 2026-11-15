import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, type Router } from 'vue-router';
import { createAppRouter } from '../../src/router';
import { useAuthStore } from '../../src/stores/auth';
import LoginView from '../../src/views/LoginView.vue';
import { errorResponse, fictionalPassword, testUser, userResponse } from '../fixtures';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let pinia: Pinia;
let router: Router;
let wrapper: VueWrapper | undefined;

async function mountLogin(): Promise<void> {
  await router.push('/login');
  await router.isReady();
  wrapper = mount(LoginView, { global: { plugins: [pinia, router] } });
}

beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(errorResponse('UNAUTHENTICATED', 401));
  vi.stubGlobal('fetch', fetchMock);
  router = createAppRouter(createMemoryHistory());
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.unstubAllGlobals();
});

describe('LoginView', () => {
  it('renders associated labels, autocomplete and loading state', async () => {
    await mountLogin();
    if (wrapper === undefined) throw new Error('Missing wrapper');

    expect(wrapper.get('label[for="login-email"]').text()).toBe('E-Mail-Adresse');
    expect(wrapper.get('#login-email').attributes('autocomplete')).toBe('email');
    expect(wrapper.get('#login-password').attributes('autocomplete')).toBe('current-password');
    expect(wrapper.get('form').attributes('novalidate')).toBeDefined();
  });

  it('validates required credentials locally without calling login', async () => {
    await mountLogin();
    if (wrapper === undefined) throw new Error('Missing wrapper');

    await wrapper.get('form').trigger('submit');

    expect(wrapper.get('#login-email').attributes('aria-invalid')).toBe('true');
    expect(wrapper.get('#login-password-error').text()).toBe('Gib dein Passwort ein.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses shared validation and does not apply the 12-character rule to login', async () => {
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith('/me')) {
        return Promise.resolve(errorResponse('UNAUTHENTICATED', 401));
      }
      return Promise.resolve(userResponse());
    });
    await mountLogin();
    if (wrapper === undefined) throw new Error('Missing wrapper');

    await wrapper.get('#login-email').setValue(' ADA@EXAMPLE.INVALID ');
    await wrapper.get('#login-password').setValue('x');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(useAuthStore().user).toEqual(testUser);
    expect(router.currentRoute.value.name).toBe('lobby');
    const loginCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/auth/login'));
    expect(JSON.parse(String(loginCall?.[1]?.body))).toEqual({
      email: 'ada@example.invalid',
      password: 'x',
    });
  });

  it('shows a generic invalid-credentials error without revealing account existence', async () => {
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith('/me')) {
        return Promise.resolve(errorResponse('UNAUTHENTICATED', 401));
      }
      return Promise.resolve(errorResponse('INVALID_CREDENTIALS', 401, 'Konto existiert nicht'));
    });
    await mountLogin();
    if (wrapper === undefined) throw new Error('Missing wrapper');

    await wrapper.get('#login-email').setValue('ada@example.invalid');
    await wrapper.get('#login-password').setValue(fictionalPassword);
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toBe('E-Mail-Adresse oder Passwort ist falsch.');
    expect(alert.text()).not.toContain('Konto');
    expect(useAuthStore().user).toBeNull();
    expect(router.currentRoute.value.name).toBe('login');
  });

  it('shows a non-sensitive CSRF/origin error and stays on the form', async () => {
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith('/me')) {
        return Promise.resolve(errorResponse('UNAUTHENTICATED', 401));
      }
      return Promise.resolve(
        errorResponse('CSRF_REJECTED', 403, 'Rejected foreign origin details'),
      );
    });
    await mountLogin();
    if (wrapper === undefined) throw new Error('Missing wrapper');

    await wrapper.get('#login-email').setValue('ada@example.invalid');
    await wrapper.get('#login-password').setValue(fictionalPassword);
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('aus Sicherheitsgründen abgelehnt');
    expect(wrapper.text()).not.toContain('Rejected foreign origin details');
    expect(wrapper.find('form').exists()).toBe(true);
  });

  it('disables duplicate submission while the server response is pending', async () => {
    let resolveLogin: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith('/me')) {
        return Promise.resolve(errorResponse('UNAUTHENTICATED', 401));
      }
      return new Promise<Response>((resolve) => {
        resolveLogin = resolve;
      });
    });
    await mountLogin();
    if (wrapper === undefined) throw new Error('Missing wrapper');

    await wrapper.get('#login-email').setValue('ada@example.invalid');
    await wrapper.get('#login-password').setValue(fictionalPassword);
    await wrapper.get('form').trigger('submit');

    const button = wrapper.get('button[type="submit"]');
    expect(button.text()).toBe('Anmeldung läuft …');
    expect(button.attributes('disabled')).toBeDefined();
    expect(wrapper.get('form').attributes('aria-busy')).toBe('true');
    expect(resolveLogin).toBeTypeOf('function');
    resolveLogin?.(userResponse());
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('lobby');
  });

  it('shows offline/API reachability errors without server internals', async () => {
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith('/me')) {
        return Promise.resolve(errorResponse('UNAUTHENTICATED', 401));
      }
      return Promise.reject(new TypeError('private socket detail'));
    });
    await mountLogin();
    if (wrapper === undefined) throw new Error('Missing wrapper');

    await wrapper.get('#login-email').setValue('ada@example.invalid');
    await wrapper.get('#login-password').setValue(fictionalPassword);
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('Internetverbindung');
    expect(wrapper.text()).not.toContain('private socket detail');
  });
});
