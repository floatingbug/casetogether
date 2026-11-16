import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiProviderFromEnv, presentCatalogueDialogue } from '../../src/ai/index.js';
import type { OpenAiHttpRequest } from '../../src/ai/index.js';
import { createApp } from '../../src/app.js';
import { readBackendConfig } from '../../src/config.js';
import { glockenschlagIds } from '../../src/game-engine/index.js';
import { runCompleteGame } from '../game-engine/helpers.js';
import { catalogContext, REFERENCE_ANSWER } from './fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider-free baseline integration', () => {
  it('keeps health/liveness and MongoDB-only readiness unchanged without reading OpenAI variables', async () => {
    const environment = new Proxy<NodeJS.ProcessEnv>(
      { NODE_ENV: 'test' },
      {
        get(target, property, receiver) {
          if (property === 'OPENAI_API_KEY' || property === 'OPENAI_MODEL') {
            throw new Error('Baseline must not read optional provider configuration');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const config = readBackendConfig(environment);
    const app = createApp({
      nodeEnv: config.nodeEnv,
      allowedOrigins: config.allowedOrigins,
      mongoDbStatus: async () => 'up',
    });

    const health = await request(app).get('/api/v1/health').expect(200);
    expect(health.body).toEqual({ data: { status: 'ok' } });
    const ready = await request(app).get('/api/v1/ready').expect(200);
    expect(ready.body).toEqual({ data: { status: 'ready', checks: { mongodb: 'up' } } });
    expect(JSON.stringify(ready.body)).not.toContain('openai');
    expect(JSON.stringify(ready.body)).not.toContain('provider');
  });

  it('does not activate a transport or provider call with missing configuration', async () => {
    const transportCalls: OpenAiHttpRequest[] = [];
    const provider = createOpenAiProviderFromEnv(
      {},
      {
        transport: {
          execute: (request) => {
            transportCalls.push(request);
            return Promise.reject(new Error('No transport is permitted in this test'));
          },
        },
      },
    );
    expect(provider).toBeNull();

    const canonical = Object.freeze({ questionId: 'q-fixed', phase: 'investigating' });
    const presentation = await presentCatalogueDialogue({
      canonical,
      context: catalogContext(),
      provider,
    });
    expect(presentation).toEqual({
      canonical,
      answerText: REFERENCE_ANSWER,
      answerSource: 'reference',
    });
    expect(transportCalls).toHaveLength(0);
  });

  it('completes the full real T007 catalog case offline with zero provider/fetch calls', () => {
    const fetchDouble = vi.fn();
    vi.stubGlobal('fetch', fetchDouble);

    const complete = runCompleteGame('t008-baseline-complete');
    expect(complete.final.state.phase).toBe('completed');
    expect(complete.final.state.result).toMatchObject({
      verdict: 'correct',
      awardedPoints: 100,
      maximumPoints: 100,
    });
    expect(complete.final.state.result?.resolution.suspectId).toBe(
      glockenschlagIds.suspects.miriam,
    );
    expect(complete.path.commands).toHaveLength(9);
    expect(fetchDouble).not.toHaveBeenCalled();
  });
});
