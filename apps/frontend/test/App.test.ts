import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';

describe('frontend scaffold smoke test', () => {
  it('renders a small accessible Vue start view without network access', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const wrapper = mount(App);

    expect(wrapper.find('main').exists()).toBe(true);
    expect(wrapper.get('h1').text()).toBe('CaseTogether');
    expect(wrapper.get('#welcome-title').text()).toBe('CaseTogether');
    expect(wrapper.text()).toContain('Keine KI-Konfiguration erforderlich');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('uses text templates rather than unsafe HTML injection', () => {
    const wrapper = mount(App);
    expect(wrapper.html()).not.toContain('v-html');
    expect(wrapper.find('script').exists()).toBe(false);
  });
});
