import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  OpenAiHttpRequest,
  OpenAiHttpResponse,
  OpenAiHttpTransport,
  OpenAiProviderLogEntry,
} from '../../src/ai/index.js';
import {
  createOpenAiProviderFromEnv,
  OPENAI_CHAT_COMPLETIONS_URL,
  OpenAiDialogueProvider,
} from '../../src/ai/index.js';
import {
  catalogContext,
  FICTIONAL_MODEL,
  FICTIONAL_OPENAI_KEY,
  openAiJsonResponse,
} from './fixtures.js';

interface TransportDouble {
  readonly transport: OpenAiHttpTransport;
  readonly calls: OpenAiHttpRequest[];
}

function transportReturning(...responses: OpenAiHttpResponse[]): TransportDouble {
  const calls: OpenAiHttpRequest[] = [];
  const queue = [...responses];
  return {
    calls,
    transport: {
      execute: (request) => {
        calls.push(request);
        const response = queue.shift();
        if (response === undefined) {
          return Promise.reject(new Error('Unexpected additional transport call'));
        }
        return Promise.resolve(response);
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OpenAI dialogue provider', () => {
  it('performs exactly one bounded request and returns only normalized dialogue', async () => {
    const double = transportReturning(
      openAiJsonResponse({ dialogue: '  Cafe\u0301 geschlossen.  ' }),
    );
    const provider = new OpenAiDialogueProvider({
      apiKey: FICTIONAL_OPENAI_KEY,
      model: FICTIONAL_MODEL,
      transport: double.transport,
    });

    await expect(provider.generateDialogue(catalogContext())).resolves.toEqual({
      ok: true,
      dialogue: 'Café geschlossen.',
    });

    expect(double.calls).toHaveLength(1);
    const request = double.calls[0];
    expect(request).toBeDefined();
    expect(request?.url).toBe(OPENAI_CHAT_COMPLETIONS_URL);
    expect(request?.method).toBe('POST');
    expect(request?.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FICTIONAL_OPENAI_KEY}`,
    });
    expect(request?.body).toMatchObject({
      model: FICTIONAL_MODEL,
      n: 1,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    });
    expect(JSON.stringify(request?.body)).not.toContain('6000');
  });

  it.each([400, 401, 429, 500, 503])(
    'maps HTTP %s to provider_error without retry or raw error details',
    async (status) => {
      const double = transportReturning(
        openAiJsonResponse({ dialogue: 'Provider error bodies are not exposed' }, status),
      );
      const provider = new OpenAiDialogueProvider({
        apiKey: FICTIONAL_OPENAI_KEY,
        model: FICTIONAL_MODEL,
        transport: double.transport,
      });

      await expect(provider.generateDialogue(catalogContext())).resolves.toEqual({
        ok: false,
        reason: 'provider_error',
      });
      expect(double.calls).toHaveLength(1);
    },
  );

  it('maps a rejected transport to provider_error exactly once', async () => {
    const calls: OpenAiHttpRequest[] = [];
    const provider = new OpenAiDialogueProvider({
      apiKey: FICTIONAL_OPENAI_KEY,
      model: FICTIONAL_MODEL,
      transport: {
        execute: (request) => {
          calls.push(request);
          return Promise.reject(new Error('offline raw provider detail'));
        },
      },
    });

    await expect(provider.generateDialogue(catalogContext())).resolves.toEqual({
      ok: false,
      reason: 'provider_error',
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['null body', null],
    ['missing choices', {}],
    ['empty choices', { choices: [] }],
    ['multiple choices', { choices: [{}, {}] }],
    ['missing message', { choices: [{}] }],
  ])('maps malformed provider envelope %s to provider_error', async (_name, body) => {
    const double = transportReturning({ status: 200, body });
    const provider = new OpenAiDialogueProvider({
      apiKey: FICTIONAL_OPENAI_KEY,
      model: FICTIONAL_MODEL,
      transport: double.transport,
    });
    await expect(provider.generateDialogue(catalogContext())).resolves.toEqual({
      ok: false,
      reason: 'provider_error',
    });
    expect(double.calls).toHaveLength(1);
  });

  it.each([
    ['non-string content', 42],
    ['null content', null],
    ['object content', { dialogue: 'not the wire string form' }],
  ])('maps %s to invalid_output', async (_name, content) => {
    const double = transportReturning({
      status: 200,
      body: { choices: [{ message: { content } }] },
    });
    const provider = new OpenAiDialogueProvider({
      apiKey: FICTIONAL_OPENAI_KEY,
      model: FICTIONAL_MODEL,
      transport: double.transport,
    });
    await expect(provider.generateDialogue(catalogContext())).resolves.toEqual({
      ok: false,
      reason: 'invalid_output',
    });
    expect(double.calls).toHaveLength(1);
  });

  it.each([
    ['malformed content JSON', '{not-json'],
    ['empty content', ''],
    [
      'extra output field',
      JSON.stringify({ dialogue: 'Text', statePatch: { phase: 'completed' } }),
    ],
    ['too-long output', JSON.stringify({ dialogue: 'a'.repeat(4001) })],
    ['empty output', JSON.stringify({ dialogue: '  ' })],
  ])('maps %s to invalid_output without retry', async (_name, content) => {
    const double = transportReturning({
      status: 200,
      body: { choices: [{ message: { content } }] },
    });
    const provider = new OpenAiDialogueProvider({
      apiKey: FICTIONAL_OPENAI_KEY,
      model: FICTIONAL_MODEL,
      transport: double.transport,
    });
    await expect(provider.generateDialogue(catalogContext())).resolves.toEqual({
      ok: false,
      reason: 'invalid_output',
    });
    expect(double.calls).toHaveLength(1);
  });

  it.each([
    [{}, 'neither value'],
    [{ apiKey: FICTIONAL_OPENAI_KEY }, 'missing model'],
    [{ model: FICTIONAL_MODEL }, 'missing key'],
    [{ apiKey: ' ', model: FICTIONAL_MODEL }, 'blank key'],
    [{ apiKey: FICTIONAL_OPENAI_KEY, model: '' }, 'blank model'],
  ])('keeps %s (%s) unavailable with zero transport calls', async (configuration, _name) => {
    const double = transportReturning(openAiJsonResponse({ dialogue: 'must not run' }));
    const provider = new OpenAiDialogueProvider({
      ...configuration,
      transport: double.transport,
    });
    await expect(provider.generateDialogue(catalogContext())).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(double.calls).toHaveLength(0);
  });

  it('does not call transport for an invalid context or unsupported prompt version', async () => {
    const double = transportReturning(openAiJsonResponse({ dialogue: 'must not run' }));
    const provider = new OpenAiDialogueProvider({
      apiKey: FICTIONAL_OPENAI_KEY,
      model: FICTIONAL_MODEL,
      transport: double.transport,
    });

    // Deliberately bypass static typing to prove the runtime guard against malformed input.
    const malformed = { ...catalogContext(), timeoutMs: 1 } as unknown as ReturnType<
      typeof catalogContext
    >;
    await expect(provider.generateDialogue(malformed)).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
    await expect(
      provider.generateDialogue(catalogContext({ promptVersion: 'unsupported.v0' })),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(double.calls).toHaveLength(0);
  });

  it('aborts the real request at 5000 ms using fake time and never retries', async () => {
    vi.useFakeTimers();
    const calls: OpenAiHttpRequest[] = [];
    const abortListener = vi.fn();
    const provider = new OpenAiDialogueProvider({
      apiKey: FICTIONAL_OPENAI_KEY,
      model: FICTIONAL_MODEL,
      transport: {
        execute: (request) => {
          calls.push(request);
          return new Promise<OpenAiHttpResponse>((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => {
                abortListener();
                reject(new DOMException('Aborted offline', 'AbortError'));
              },
              { once: true },
            );
          });
        },
      },
    });

    const resultPromise = provider.generateDialogue(catalogContext());
    let settled = false;
    void resultPromise.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toHaveLength(1);
    expect(abortListener).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(abortListener).toHaveBeenCalledTimes(1);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('settles at timeout even when an offline transport ignores abort', async () => {
    vi.useFakeTimers();
    let requestSeen: OpenAiHttpRequest | undefined;
    const provider = new OpenAiDialogueProvider({
      apiKey: FICTIONAL_OPENAI_KEY,
      model: FICTIONAL_MODEL,
      transport: {
        execute: (request) => {
          requestSeen = request;
          return new Promise<OpenAiHttpResponse>(() => undefined);
        },
      },
    });

    const resultPromise = provider.generateDialogue(catalogContext());
    await vi.advanceTimersByTimeAsync(5000);
    await expect(resultPromise).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(requestSeen?.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('emits only sanitized category/requestId log entries', async () => {
    const entries: OpenAiProviderLogEntry[] = [];
    const secretMarkers = [
      FICTIONAL_OPENAI_KEY,
      FICTIONAL_MODEL,
      'private spoiler marker',
      catalogContext().questionText,
      'raw provider answer',
    ];
    const provider = new OpenAiDialogueProvider({
      apiKey: FICTIONAL_OPENAI_KEY,
      model: FICTIONAL_MODEL,
      requestIdFactory: () => 'request-safe-fixture-id',
      logger: (entry) => entries.push(entry),
      transport: {
        execute: () =>
          Promise.reject(
            new Error(`raw provider answer ${FICTIONAL_OPENAI_KEY} ${FICTIONAL_MODEL}`),
          ),
      },
    });

    await expect(
      provider.generateDialogue(
        catalogContext({ questionText: 'private spoiler marker in an otherwise public question' }),
      ),
    ).resolves.toEqual({ ok: false, reason: 'provider_error' });
    expect(entries).toEqual([{ category: 'provider_error', requestId: 'request-safe-fixture-id' }]);
    for (const marker of secretMarkers) {
      expect(JSON.stringify(entries)).not.toContain(marker);
    }
  });
});

describe('explicit OpenAI environment activation', () => {
  it('returns null only when both optional values are absent or blank', () => {
    const double = transportReturning(openAiJsonResponse({ dialogue: 'must not run' }));
    expect(createOpenAiProviderFromEnv({}, { transport: double.transport })).toBeNull();
    expect(
      createOpenAiProviderFromEnv(
        { OPENAI_API_KEY: '', OPENAI_MODEL: '  ' },
        { transport: double.transport },
      ),
    ).toBeNull();
    expect(double.calls).toHaveLength(0);
  });

  it('uses only the two existing variables and safely disables partial activation', async () => {
    const double = transportReturning(openAiJsonResponse({ dialogue: 'must not run' }));
    const partial = createOpenAiProviderFromEnv(
      { OPENAI_API_KEY: FICTIONAL_OPENAI_KEY },
      { transport: double.transport },
    );
    expect(partial).not.toBeNull();
    if (partial !== null) {
      await expect(partial.generateDialogue(catalogContext())).resolves.toEqual({
        ok: false,
        reason: 'unavailable',
      });
    }
    expect(double.calls).toHaveLength(0);
  });
});
