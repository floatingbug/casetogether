import type {
  CatalogDialogueContext,
  FreeTextDialogueContext,
  OpenAiHttpResponse,
} from '../../src/ai/index.js';
import { SUSPECT_DIALOGUE_PROMPT_VERSION } from '../../src/ai/index.js';

export const FICTIONAL_OPENAI_KEY = 'fiction-only-openai-key-never-valid';
export const FICTIONAL_MODEL = 'fiction-dialogue-model-v1';
export const PUBLIC_CHARACTER_CONTEXT =
  'Öffentlicher Charakter: Ein Nachtwächter antwortet sachlich und knapp.';
export const ALLOWED_FACTS = [
  'Der Rundgang begann um 20:40 Uhr.',
  'Die Außentüren waren verriegelt.',
];
export const REFERENCE_ANSWER =
  'Ich begann meinen Rundgang um 20:40 Uhr. Die Außentüren waren verriegelt.';

export function catalogContext(
  overrides: Partial<CatalogDialogueContext> = {},
): CatalogDialogueContext {
  return {
    mode: 'catalog',
    questionText: 'Was haben Sie bei Ihrem Rundgang beobachtet?',
    publicCharacterContext: PUBLIC_CHARACTER_CONTEXT,
    allowedFacts: [...ALLOWED_FACTS],
    referenceAnswer: REFERENCE_ANSWER,
    language: 'de',
    promptVersion: SUSPECT_DIALOGUE_PROMPT_VERSION,
    timeoutMs: 5000,
    maxOutputTokens: 600,
    ...overrides,
  };
}

export function freeTextContext(
  overrides: Partial<FreeTextDialogueContext> = {},
): FreeTextDialogueContext {
  return {
    mode: 'free_text',
    questionText: 'War die Galerie während Ihres Rundgangs leer?',
    publicCharacterContext: PUBLIC_CHARACTER_CONTEXT,
    allowedFacts: [...ALLOWED_FACTS],
    referenceAnswer: null,
    language: 'de',
    promptVersion: SUSPECT_DIALOGUE_PROMPT_VERSION,
    timeoutMs: 5000,
    maxOutputTokens: 600,
    ...overrides,
  };
}

export function openAiJsonResponse(modelOutput: unknown, status = 200): OpenAiHttpResponse {
  return {
    status,
    body: {
      id: 'fiction-provider-envelope-id',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(modelOutput) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) {
    throw new Error('Deferred promise was not initialized');
  }
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
