import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchOpenAiHttpTransport, OPENAI_CHAT_COMPLETIONS_URL } from '../../src/ai/index.js';
import { FICTIONAL_OPENAI_KEY } from './fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('injectable fetch transport', () => {
  it('serializes one request and parses its JSON response using only a mocked fetch', async () => {
    const fetchDouble = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchDouble);
    const controller = new AbortController();
    const transport = new FetchOpenAiHttpTransport();

    await expect(
      transport.execute({
        url: OPENAI_CHAT_COMPLETIONS_URL,
        method: 'POST',
        headers: { Authorization: `Bearer ${FICTIONAL_OPENAI_KEY}` },
        body: { model: 'fiction-model' },
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: 200, body: { choices: [] } });

    expect(fetchDouble).toHaveBeenCalledTimes(1);
    expect(fetchDouble).toHaveBeenCalledWith(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FICTIONAL_OPENAI_KEY}` },
      body: '{"model":"fiction-model"}',
      signal: controller.signal,
    });
  });

  it('returns a null body for an empty response and propagates malformed JSON as a local error', async () => {
    const responses = [
      new Response(null, { status: 204 }),
      new Response('{broken', { status: 200 }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = responses.shift();
        if (response === undefined) {
          throw new Error('Unexpected mocked fetch');
        }
        return response;
      }),
    );
    const transport = new FetchOpenAiHttpTransport();
    const request = {
      url: OPENAI_CHAT_COMPLETIONS_URL,
      method: 'POST',
      headers: {},
      body: {},
      signal: new AbortController().signal,
    } as const;

    await expect(transport.execute(request)).resolves.toEqual({ status: 204, body: null });
    await expect(transport.execute(request)).rejects.toBeInstanceOf(SyntaxError);
  });
});
