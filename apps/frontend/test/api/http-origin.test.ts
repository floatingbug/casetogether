import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRequestUrl } from '../../src/api/http';
import { API_ORIGIN } from '../../src/config/api-origin';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
});

describe('REST request URLs and the build-time API origin', () => {
  it('uses the configured build-time origin by default', () => {
    expect(buildRequestUrl('/me')).toBe(`${API_ORIGIN}/api/v1/me`);
  });

  it('keeps the historical relative path when no origin is configured', () => {
    expect(buildRequestUrl('/auth/login', '')).toBe('/api/v1/auth/login');
    expect(buildRequestUrl('/rooms/join', '')).toBe('/api/v1/rooms/join');
  });

  it('prefixes an absolute origin without introducing a double slash', () => {
    expect(buildRequestUrl('/sessions/abc/final-submission', 'https://api.example.com')).toBe(
      'https://api.example.com/api/v1/sessions/abc/final-submission',
    );
  });

  it('sends credentialled requests to the configured origin', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/api-origin', () => ({
      API_ORIGIN: 'https://api.casetogether.tasse-voll-code.de',
    }));
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { requestNoContent } = await import('../../src/api/http');

    await requestNoContent(
      { method: 'POST', path: '/auth/logout', expectedStatuses: [204] },
      { fetcher: fetchMock },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.casetogether.tasse-voll-code.de/api/v1/auth/logout',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
    });
  });
});
