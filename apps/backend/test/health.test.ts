import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { HealthResponseSchema, ReadinessResponseSchema } from '@casetogether/shared';
import { createApp } from '../src/app.js';

const expectedNotReady = {
  data: { status: 'not_ready', checks: { mongodb: 'down' } },
};

describe('system endpoints without provider configuration', () => {
  it('returns the exact OpenAPI health body with HTTP 200', async () => {
    const app = createApp({ nodeEnv: 'test' });
    const response = await request(app).get('/api/v1/health').expect(200);

    expect(response.body).toEqual({ data: { status: 'ok' } });
    expect(HealthResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('honestly reports not_ready until the T003 MongoDB adapter exists', async () => {
    const app = createApp({ nodeEnv: 'test' });
    const response = await request(app).get('/api/v1/ready').expect(503);

    expect(response.body).toEqual(expectedNotReady);
    expect(ReadinessResponseSchema.safeParse(response.body).success).toBe(true);
  });

  it('maps only an injected required-MongoDB check to readiness, never a provider check', async () => {
    let databaseChecks = 0;
    const app = createApp({
      nodeEnv: 'test',
      mongoDbStatus: async () => {
        databaseChecks += 1;
        return 'up';
      },
    });

    const response = await request(app).get('/api/v1/ready').expect(200);
    expect(response.body).toEqual({ data: { status: 'ready', checks: { mongodb: 'up' } } });
    expect(databaseChecks).toBe(1);
  });

  it('classifies a failed required dependency probe as not_ready without internals', async () => {
    const app = createApp({
      nodeEnv: 'test',
      mongoDbStatus: async () => {
        throw new Error('database details must not leak');
      },
    });

    const response = await request(app).get('/api/v1/ready').expect(503);
    expect(response.body).toEqual(expectedNotReady);
    expect(JSON.stringify(response.body)).not.toContain('database details');
  });

  it('keeps liveness independent from database readiness', async () => {
    let databaseChecks = 0;
    const app = createApp({
      nodeEnv: 'test',
      mongoDbStatus: async () => {
        databaseChecks += 1;
        return 'down';
      },
    });

    await request(app).get('/api/v1/health').expect(200);
    expect(databaseChecks).toBe(0);
  });
});
