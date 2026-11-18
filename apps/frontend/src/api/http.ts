import { ErrorResponseSchema, type ErrorCode, type ErrorDetails } from '@casetogether/shared';
import type { z } from 'zod';
import { API_ORIGIN } from '../config/api-origin';

export type ApiClientErrorCode =
  | ErrorCode
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR';

export class ApiClientError extends Error {
  readonly code: ApiClientErrorCode;
  readonly status: number | null;
  readonly requestId: string | undefined;
  readonly details: ErrorDetails | undefined;

  constructor(
    code: ApiClientErrorCode,
    message: string,
    options: {
      status?: number;
      requestId?: string;
      details?: ErrorDetails;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiClientError';
    this.code = code;
    this.status = options.status ?? null;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

interface RequestConfiguration {
  method: 'GET' | 'POST';
  path: `/${string}`;
  expectedStatuses: readonly number[];
  body?: unknown;
  requestSchema?: z.ZodType;
}

interface RequestOptions {
  fetcher?: typeof fetch;
}

function defaultFetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

/**
 * Builds the REST URL from the optional build-time backend origin and the existing API path.
 * With an empty origin the URL stays relative, which keeps local dev, preview and tests on the
 * Vite same-origin proxy.
 */
export function buildRequestUrl(path: `/${string}`, origin: string = API_ORIGIN): string {
  return `${origin}/api/v1${path}`;
}

function isJsonResponse(response: Response): boolean {
  return (
    response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ?? false
  );
}

async function readJson(response: Response): Promise<unknown> {
  if (!isJsonResponse(response)) {
    throw new ApiClientError('INVALID_RESPONSE', 'The server returned a non-JSON response', {
      status: response.status,
    });
  }

  try {
    return await response.json();
  } catch (error: unknown) {
    throw new ApiClientError('INVALID_RESPONSE', 'The server returned malformed JSON', {
      status: response.status,
      cause: error,
    });
  }
}

async function send(
  configuration: RequestConfiguration,
  options: RequestOptions,
): Promise<unknown> {
  let body: string | undefined;
  if (configuration.body !== undefined) {
    const parsedBody = configuration.requestSchema?.safeParse(configuration.body);
    if (parsedBody !== undefined && !parsedBody.success) {
      throw new ApiClientError('INVALID_REQUEST', 'The request does not match its shared schema', {
        cause: parsedBody.error,
      });
    }
    body = JSON.stringify(parsedBody?.success ? parsedBody.data : configuration.body);
  }

  const init: RequestInit = {
    method: configuration.method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body }),
  };

  let response: Response;
  try {
    response = await (options.fetcher ?? defaultFetcher)(buildRequestUrl(configuration.path), init);
  } catch (error: unknown) {
    throw new ApiClientError('NETWORK_ERROR', 'The API request could not reach the server', {
      cause: error,
    });
  }

  if (!response.ok) {
    const payload = await readJson(response);
    const parsedError = ErrorResponseSchema.safeParse(payload);
    if (!parsedError.success) {
      throw new ApiClientError(
        'INVALID_RESPONSE',
        'The error response violates its shared schema',
        {
          status: response.status,
          cause: parsedError.error,
        },
      );
    }

    const apiError = parsedError.data.error;
    throw new ApiClientError(apiError.code, apiError.message, {
      status: response.status,
      requestId: apiError.requestId,
      ...(apiError.details === undefined ? {} : { details: apiError.details }),
    });
  }

  if (!configuration.expectedStatuses.includes(response.status)) {
    throw new ApiClientError('INVALID_RESPONSE', 'The server returned an unexpected HTTP status', {
      status: response.status,
    });
  }

  if (response.status === 204) {
    return undefined;
  }

  return readJson(response);
}

export async function requestData<Output>(
  configuration: RequestConfiguration & { responseSchema: z.ZodType<Output> },
  options: RequestOptions = {},
): Promise<Output> {
  const payload = await send(configuration, options);
  const parsedResponse = configuration.responseSchema.safeParse(payload);
  if (!parsedResponse.success) {
    throw new ApiClientError(
      'INVALID_RESPONSE',
      'The success response violates its shared schema',
      {
        cause: parsedResponse.error,
      },
    );
  }
  return parsedResponse.data;
}

export async function requestNoContent(
  configuration: RequestConfiguration,
  options: RequestOptions = {},
): Promise<void> {
  await send(configuration, options);
}
