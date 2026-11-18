import { describe, expect, it } from 'vitest';
import { API_ORIGIN, normalizeApiOrigin } from '../../src/config/api-origin';

describe('normalizeApiOrigin', () => {
  it.each([undefined, null, '', '   '])('returns an empty origin for %j', (raw) => {
    expect(normalizeApiOrigin(raw)).toBe('');
  });

  it('accepts an absolute https origin', () => {
    expect(normalizeApiOrigin('https://api.casetogether.tasse-voll-code.de')).toBe(
      'https://api.casetogether.tasse-voll-code.de',
    );
    expect(normalizeApiOrigin('https://api.example.com:8443')).toBe('https://api.example.com:8443');
  });

  it('trims whitespace and removes a single trailing slash', () => {
    expect(normalizeApiOrigin('https://api.example.com/')).toBe('https://api.example.com');
    expect(normalizeApiOrigin('  https://api.example.com/  ')).toBe('https://api.example.com');
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:5173'])(
    'allows plain http for local development (%s)',
    (raw) => {
      expect(normalizeApiOrigin(raw)).toBe(raw);
    },
  );

  it.each([
    'http://api.example.com',
    'http://localhost.example.com',
    'http://192.168.0.5:3000',
    'ftp://api.example.com',
  ])('rejects non-https origins outside localhost (%s)', (raw) => {
    expect(() => normalizeApiOrigin(raw)).toThrow(/VITE_API_ORIGIN must use https/);
  });

  it.each([
    'https://api.example.com/v1',
    'https://api.example.com?debug=1',
    'https://api.example.com#fragment',
    'https://user:secret@api.example.com',
  ])('rejects origins with path, query, hash or credentials (%s)', (raw) => {
    expect(() => normalizeApiOrigin(raw)).toThrow(/must not contain a path, query, hash/);
  });

  it.each(['api.example.com', 'https://', 'not a url', '//api.example.com'])(
    'rejects values that are not absolute URLs (%s)',
    (raw) => {
      expect(() => normalizeApiOrigin(raw)).toThrow(/must be an absolute origin/);
    },
  );

  it('keeps the exported origin consistent with the build-time variable', () => {
    expect(API_ORIGIN).toBe(normalizeApiOrigin(import.meta.env.VITE_API_ORIGIN));
    expect(API_ORIGIN.endsWith('/')).toBe(false);
  });
});
