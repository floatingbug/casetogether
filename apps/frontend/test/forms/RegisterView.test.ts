import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, type Router } from 'vue-router';
import { createAppRouter } from '../../src/router';
import { useAuthStore } from '../../src/stores/auth';
import RegisterView from '../../src/views/RegisterView.vue';
import { errorResponse, fictionalPassword, testUser, userResponse } from '../fixtures';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let pinia: Pinia;
let router: Router;
let wrapper: VueWrapper | undefined;

async function mountRegister(): Promise<void> {
  await router.push('/register');
  await router.isReady();
  wrapper = mount(RegisterView, { global: { plugins: [pinia, router] } });
}

beforeEach(() => {
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

describe('RegisterView', () => {
  it('shows shared boundary validation including display name and 12-character password', async () => {
    await mountRegister();
    if (wrapper === undefined) throw new Error('Missing wrapper');

    await wrapper.get('#register-display-name').setValue('   ');
    await wrapper.get('#register-email').setValue('not-an-email');
    await wrapper.get('#register-password').setValue('too-short');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.get('#register-display-name-error').text()).toContain('1–32 Zeichen');
    expect(wrapper.get('#register-email-error').text()).toContain('höchstens 254');
    expect(wrapper.get('#register-password-error').text()).toContain('12 und 128');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('registers successfully without imposing uppercase or special-character classes', async () => {
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith('/me')) {
        return Promise.resolve(errorResponse('UNAUTHENTICATED', 401));
      }
      return Promise.resolve(userResponse(201));
    });
    await mountRegister();
    if (wrapper === undefined) throw new Error('Missing wrapper');

    await wrapper.get('#register-display-name').setValue('  Ada Test  ');
    await wrapper.get('#register-email').setValue(' ADA@EXAMPLE.INVALID ');
    await wrapper.get('#register-password').setValue('abcdefghijkl');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(useAuthStore().user).toEqual(testUser);
    expect(router.currentRoute.value.name).toBe('lobby');
    const registerCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith('/auth/register'),
    );
    expect(JSON.parse(String(registerCall?.[1]?.body))).toEqual({
      displayName: 'Ada Test',
      email: 'ada@example.invalid',
      password: 'abcdefghijkl',
    });
  });

  it('shows the contract-approved duplicate-email error only for registration', async () => {
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith('/me')) {
        return Promise.resolve(errorResponse('UNAUTHENTICATED', 401));
      }
      return Promise.resolve(errorResponse('EMAIL_ALREADY_REGISTERED', 409));
    });
    await mountRegister();
    if (wrapper === undefined) throw new Error('Missing wrapper');

    await wrapper.get('#register-display-name').setValue('Ada Test');
    await wrapper.get('#register-email').setValue('ada@example.invalid');
    await wrapper.get('#register-password').setValue(fictionalPassword);
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('existiert bereits ein Konto');
    expect(useAuthStore().user).toBeNull();
    expect(router.currentRoute.value.name).toBe('register');
  });

  it('keeps password validation limited to the shared 12–128 character boundaries', async () => {
    await mountRegister();
    if (wrapper === undefined) throw new Error('Missing wrapper');

    await wrapper.get('#register-display-name').setValue('Ada Test');
    await wrapper.get('#register-email').setValue('ada@example.invalid');
    await wrapper.get('#register-password').setValue('x'.repeat(129));
    await wrapper.get('form').trigger('submit');

    expect(wrapper.get('#register-password-error').text()).toContain('12 und 128');
    expect(wrapper.text()).not.toMatch(/Großbuchstabe|Sonderzeichen erforderlich/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
