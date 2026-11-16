import { randomUUID } from 'node:crypto';
import {
  AuthorizedDialogueContextSchema,
  parseDialogueModelOutput,
  type AiProviderResult,
  type AuthorizedDialogueContext,
  type DialogueProvider,
} from './contracts.js';
import {
  FetchOpenAiHttpTransport,
  OPENAI_CHAT_COMPLETIONS_URL,
  type OpenAiHttpTransport,
} from './http-transport.js';
import { buildDialoguePrompt } from './prompts.js';

export interface OpenAiProviderLogEntry {
  readonly category: 'timeout' | 'provider_error' | 'invalid_output';
  readonly requestId: string;
}

export type OpenAiProviderLogger = (entry: OpenAiProviderLogEntry) => void;

export interface OpenAiProviderOptions {
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly transport?: OpenAiHttpTransport;
  readonly logger?: OpenAiProviderLogger;
  readonly requestIdFactory?: () => string;
}

export type OpenAiProviderActivationOptions = Omit<OpenAiProviderOptions, 'apiKey' | 'model'>;

export interface OpenAiEnvironment {
  readonly OPENAI_API_KEY?: string | undefined;
  readonly OPENAI_MODEL?: string | undefined;
}

function property(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function firstChoiceContent(body: unknown): {
  readonly validEnvelope: boolean;
  readonly content?: unknown;
} {
  if (typeof body !== 'object' || body === null) {
    return { validEnvelope: false };
  }
  const choices = property(body, 'choices');
  if (!Array.isArray(choices) || choices.length !== 1) {
    return { validEnvelope: false };
  }
  const choice: unknown = choices[0];
  if (typeof choice !== 'object' || choice === null) {
    return { validEnvelope: false };
  }
  const message = property(choice, 'message');
  if (typeof message !== 'object' || message === null) {
    return { validEnvelope: false };
  }
  return { validEnvelope: true, content: property(message, 'content') };
}

function failure(reason: 'unavailable' | 'timeout' | 'provider_error' | 'invalid_output') {
  return { ok: false, reason } as const;
}

/** Optional OpenAI adapter. Exactly one transport execution is started per invocation. */
export class OpenAiDialogueProvider implements DialogueProvider {
  readonly #apiKey: string | undefined;
  readonly #model: string | undefined;
  readonly #transport: OpenAiHttpTransport;
  readonly #logger: OpenAiProviderLogger;
  readonly #requestIdFactory: () => string;

  constructor(options: OpenAiProviderOptions = {}) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#transport = options.transport ?? new FetchOpenAiHttpTransport();
    this.#logger = options.logger ?? (() => undefined);
    this.#requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async generateDialogue(context: AuthorizedDialogueContext): Promise<AiProviderResult> {
    const parsedContext = AuthorizedDialogueContextSchema.safeParse(context);
    const apiKey = this.#apiKey?.trim();
    const model = this.#model?.trim();
    if (
      !parsedContext.success ||
      apiKey === undefined ||
      apiKey.length === 0 ||
      model === undefined ||
      model.length === 0
    ) {
      return failure('unavailable');
    }

    const authorizedContext = parsedContext.data;
    const prompt = buildDialoguePrompt(authorizedContext);
    if (prompt === null) {
      return failure('unavailable');
    }

    const requestId = this.#requestIdFactory();
    const abortController = new AbortController();
    let didTimeout = false;
    let timer: NodeJS.Timeout | undefined;

    const transportAttempt = Promise.resolve()
      .then(() =>
        this.#transport.execute({
          url: OPENAI_CHAT_COMPLETIONS_URL,
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: {
            model,
            messages: prompt.messages,
            n: 1,
            max_tokens: authorizedContext.maxOutputTokens,
            response_format: { type: 'json_object' },
          },
          signal: abortController.signal,
        }),
      )
      .then((response): AiProviderResult => {
        if (response.status < 200 || response.status >= 300) {
          return failure('provider_error');
        }
        const content = firstChoiceContent(response.body);
        if (!content.validEnvelope) {
          return failure('provider_error');
        }
        if (typeof content.content !== 'string') {
          return failure('invalid_output');
        }

        let modelOutput: unknown;
        try {
          modelOutput = JSON.parse(content.content);
        } catch {
          return failure('invalid_output');
        }
        return parseDialogueModelOutput(modelOutput);
      })
      .catch((): AiProviderResult => {
        return didTimeout || abortController.signal.aborted
          ? failure('timeout')
          : failure('provider_error');
      });

    const timeout = new Promise<AiProviderResult>((resolve) => {
      timer = setTimeout(() => {
        didTimeout = true;
        abortController.abort();
        resolve(failure('timeout'));
      }, authorizedContext.timeoutMs);
    });

    try {
      const result = await Promise.race([transportAttempt, timeout]);
      if (!result.ok && result.reason !== 'unavailable' && result.reason !== 'budget_exceeded') {
        this.#logger({ category: result.reason, requestId });
      }
      return result;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      abortController.abort();
    }
  }
}

/**
 * Explicit opt-in composition hook. Nothing imports/calls this in the baseline startup path.
 * Both unset values mean no provider; any partial non-empty activation stays unavailable safely.
 */
export function createOpenAiProviderFromEnv(
  environment: OpenAiEnvironment,
  options: OpenAiProviderActivationOptions = {},
): DialogueProvider | null {
  const apiKey = environment.OPENAI_API_KEY;
  const model = environment.OPENAI_MODEL;
  if (
    (apiKey === undefined || apiKey.trim().length === 0) &&
    (model === undefined || model.trim().length === 0)
  ) {
    return null;
  }
  return new OpenAiDialogueProvider({ ...options, apiKey, model });
}
