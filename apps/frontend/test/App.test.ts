import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, type Router } from 'vue-router';
import App from '../src/App.vue';
import { createAppRouter } from '../src/router';
import { useAuthStore } from '../src/stores/auth';
import { errorResponse, userResponse } from './fixtures';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let pinia: Pinia;
let router: Router;
let wrapper: VueWrapper | undefined;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  router = createAppRouter(createMemoryHistory());
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.unstubAllGlobals();
});

describe('application layout', () => {
  it('renders accessible login navigation without network access beyond session bootstrap', async () => {
    fetchMock.mockResolvedValue(errorResponse('UNAUTHENTICATED', 401));
    await router.push('/login');
    await router.isReady();
    wrapper = mount(App, { global: { plugins: [pinia, router] } });

    expect(wrapper.get('main').attributes('id')).toBe('main-content');
    expect(wrapper.get('.skip-link').attributes('href')).toBe('#main-content');
    expect(wrapper.get('nav').attributes('aria-label')).toBe('Hauptnavigation');
    expect(wrapper.get('h1').text()).toBe('Anmelden');
    expect(wrapper.find('script').exists()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('logs out, removes private view state and reports an unconfirmed 404 server logout', async () => {
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith('/me')) {
        return Promise.resolve(userResponse());
      }
      return Promise.resolve(errorResponse('NOT_FOUND', 404));
    });
    await router.push('/');
    await router.isReady();
    wrapper = mount(App, { global: { plugins: [pinia, router] } });

    expect(wrapper.get('h1').text()).toContain('Willkommen, Ada Test');
    await wrapper.get('button.logout-button').trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.name).toBe('login');
    expect(useAuthStore().user).toBeNull();
    expect(wrapper.text()).not.toContain('Willkommen, Ada Test');
    expect(wrapper.get('[role="status"]').text()).toContain('nicht bestätigen');
  });

  it('announces offline state and removes the notice after reconnecting', async () => {
    fetchMock.mockResolvedValue(errorResponse('UNAUTHENTICATED', 401));
    const onLine = vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(false);
    await router.push('/login');
    await router.isReady();
    wrapper = mount(App, { global: { plugins: [pinia, router] } });
    await flushPromises();

    expect(wrapper.get('.offline-notice').text()).toContain('Du bist offline');
    onLine.mockReturnValue(true);
    globalThis.dispatchEvent(new Event('online'));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.offline-notice').exists()).toBe(false);
  });
});
