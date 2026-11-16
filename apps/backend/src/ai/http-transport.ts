export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

export interface OpenAiHttpRequest {
  readonly url: typeof OPENAI_CHAT_COMPLETIONS_URL;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export interface OpenAiHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Injectable server transport. Tests always replace this port with an offline double. */
export interface OpenAiHttpTransport {
  execute(request: OpenAiHttpRequest): Promise<OpenAiHttpResponse>;
}

export class FetchOpenAiHttpTransport implements OpenAiHttpTransport {
  async execute(request: OpenAiHttpRequest): Promise<OpenAiHttpResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: request.signal,
    });
    const rawBody = await response.text();
    const body: unknown = rawBody.length === 0 ? null : JSON.parse(rawBody);
    return { status: response.status, body };
  }
}
