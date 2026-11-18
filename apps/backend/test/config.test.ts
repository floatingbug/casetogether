import { describe, expect, it } from 'vitest';
import { readBackendConfig, readBackendRuntimeConfig } from '../src/config.js';
import { TEST_SESSION_SECRET } from './support/auth-test-app.js';

describe('runtime dependency configuration', () => {
  it('requires explicit MongoDB and high-entropy auth secret values', () => {
    const configuration = readBackendRuntimeConfig({
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/casetogether_test',
      SESSION_SECRET: TEST_SESSION_SECRET,
      FRONTEND_ORIGIN: 'https://frontend.example',
    });

    expect(configuration.mongodbUri).toBe('mongodb://127.0.0.1:27017/casetogether_test');
    expect(configuration.sessionSecret).toBe(TEST_SESSION_SECRET);
    expect(configuration.authCookie.secure).toBe(true);
    expect(configuration.authCookie.sameSite).toBe('none');
  });

  it.each([
    [{ MONGODB_URI: 'mongodb://127.0.0.1/test' }, /SESSION_SECRET/],
    [{ MONGODB_URI: 'mongodb://127.0.0.1/test', SESSION_SECRET: 'too-short' }, /at least 32 bytes/],
    [{ SESSION_SECRET: TEST_SESSION_SECRET }, /MONGODB_URI/],
    [
      { SESSION_SECRET: TEST_SESSION_SECRET, MONGODB_URI: 'https://not-mongodb.example' },
      /MONGODB_URI/,
    ],
  ])('rejects unsafe or absent runtime configuration %#', (environment, expectedMessage) => {
    expect(() => readBackendRuntimeConfig(environment)).toThrow(expectedMessage);
  });

  it('does not include a rejected secret or URI in configuration errors', () => {
    const secret = 'short-rejected-value';
    const uri = 'https://private-uri-value.invalid';

    let thrown: unknown;
    try {
      readBackendRuntimeConfig({ SESSION_SECRET: secret, MONGODB_URI: uri });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (thrown instanceof Error) {
      expect(thrown.message).not.toContain(secret);
      expect(thrown.message).not.toContain(uri);
    }
  });
});

describe('auth cookie SameSite and Secure by environment', () => {
  it.each(['development', 'test'] as const)('uses SameSite=Lax without Secure in %s', (nodeEnv) => {
    const cookie = readBackendConfig({ NODE_ENV: nodeEnv }).authCookie;

    expect(cookie).toMatchObject({
      name: 'ct_session',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
    });
  });

  it('uses SameSite=None with Secure in production for the cross-site frontend', () => {
    const cookie = readBackendConfig({ NODE_ENV: 'production' }).authCookie;

    expect(cookie).toMatchObject({
      name: 'ct_session',
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
    });
  });
});
