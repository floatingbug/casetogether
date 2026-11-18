import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseAllowedOrigins, readBackendConfig } from '../src/config.js';

const allowedOrigin = 'http://localhost:5173';

function createSecurityTestApp() {
  return createApp({ allowedOrigins: [allowedOrigin], nodeEnv: 'test' });
}

describe('ADR-002 origin and cookie baseline', () => {
  it('uses exact origin matching with credentials, never a wildcard', async () => {
    const response = await request(createSecurityTestApp())
      .options('/api/v1/health')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);

    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('does not emit an allow-origin header for an untrusted origin', async () => {
    const response = await request(createSecurityTestApp())
      .options('/api/v1/health')
      .set('Origin', 'https://untrusted.example')
      .set('Access-Control-Request-Method', 'GET')
      .expect(404);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it.each([undefined, 'https://untrusted.example'])('rejects unsafe origin %s', async (origin) => {
    let call = request(createSecurityTestApp()).post('/api/v1/not-implemented').send({});
    if (origin !== undefined) {
      call = call.set('Origin', origin);
    } else {
      call = call.set('Content-Type', 'application/json');
    }
    const response = await call.expect(403);
    expect(response.body.error.code).toBe('CSRF_REJECTED');
    expect(response.body.error.stack).toBeUndefined();
  });

  it('accepts an allowlisted origin even when Sec-Fetch-Site is cross-site', async () => {
    const response = await request(createSecurityTestApp())
      .post('/api/v1/not-implemented')
      .set('Origin', allowedOrigin)
      .set('Sec-Fetch-Site', 'cross-site')
      .send({})
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('still rejects an untrusted origin with cross-site fetch metadata', async () => {
    const response = await request(createSecurityTestApp())
      .post('/api/v1/not-implemented')
      .set('Origin', 'https://untrusted.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({})
      .expect(403);
    expect(response.body.error.code).toBe('CSRF_REJECTED');
  });

  it('rejects non-JSON unsafe bodies', async () => {
    const response = await request(createSecurityTestApp())
      .post('/api/v1/not-implemented')
      .set('Origin', allowedOrigin)
      .set('Content-Type', 'text/plain')
      .send('not-json')
      .expect(403);
    expect(response.body.error.code).toBe('CSRF_REJECTED');
  });

  it('supplies but does not prematurely apply the future auth-cookie attributes', () => {
    const development = readBackendConfig({ NODE_ENV: 'development' });
    expect(development.authCookie).toEqual({
      name: 'ct_session',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
    });
    const production = readBackendConfig({ NODE_ENV: 'production' });
    expect(production.authCookie.secure).toBe(true);
  });

  it('trusts only loopback proxies for forwarded client addresses', async () => {
    const app = createSecurityTestApp();
    expect(app.get('trust proxy')).toBe('loopback');

    const probe = express();
    probe.set('trust proxy', app.get('trust proxy'));
    probe.get('/client-ip', (clientRequest, clientResponse) => {
      clientResponse.status(200).json({ ip: clientRequest.ip });
    });

    const response = await request(probe)
      .get('/client-ip')
      .set('X-Forwarded-For', '203.0.113.7')
      .expect(200);

    expect(response.body).toEqual({ ip: '203.0.113.7' });
  });

  it('validates origins for direct application composition too', () => {
    expect(() => createApp({ allowedOrigins: ['*'] })).toThrow(/wildcard/);
  });

  it.each(['*', 'http://localhost:5173/', 'file:///tmp/client'])(
    'rejects invalid origin configuration %s',
    (origin) => {
      expect(() => parseAllowedOrigins(origin)).toThrow();
    },
  );
});

describe('HTTP limits and security headers', () => {
  it('rejects payloads above 16 KiB before processing', async () => {
    const response = await request(createSecurityTestApp())
      .post('/api/v1/not-implemented')
      .set('Origin', allowedOrigin)
      .set('Content-Type', 'application/json')
      .send({ content: 'x'.repeat(17 * 1024) })
      .expect(413);

    expect(response.body).toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'JSON payload exceeds the 16 KiB limit',
        requestId: response.body.error.requestId,
      },
    });
  });

  it('classifies malformed JSON without exposing parser details', async () => {
    const response = await request(createSecurityTestApp())
      .post('/api/v1/not-implemented')
      .set('Origin', allowedOrigin)
      .set('Content-Type', 'application/json')
      .send('{not-json')
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('Malformed JSON request body');
  });

  it('sets the restrictive baseline without development HSTS', async () => {
    const response = await request(createSecurityTestApp()).get('/api/v1/health').expect(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['strict-transport-security']).toBeUndefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('provider-free scaffold architecture', () => {
  it('contains no AI adapter, provider dependency or provider configuration access', () => {
    const sourceDirectory = fileURLToPath(new URL('../src', import.meta.url));
    const sourceFiles = readdirSync(sourceDirectory)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => join(sourceDirectory, file));
    expect(sourceFiles.length).toBeGreaterThan(0);
    const source = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const forbidden of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'DialogueProvider', '/ai/']) {
      expect(source.includes(forbidden)).toBe(false);
    }
  });
});
