import type {
  AiProviderResult,
  CatalogDialogueContext,
  DialogueProvider,
  FreeTextDialogueContext,
} from './contracts.js';

export type AnswerSource = 'reference' | 'ai' | 'fallback';

export interface CatalogueDialoguePresentation<TCanonical> {
  /** The exact value computed deterministically before presentation; never rewritten by AI. */
  readonly canonical: TCanonical;
  readonly answerText: string;
  readonly answerSource: AnswerSource;
}

export interface CataloguePresentationInput<TCanonical> {
  readonly canonical: TCanonical;
  readonly context: CatalogDialogueContext;
  readonly provider: DialogueProvider | null;
}

export function cataloguePresentationFromResult<TCanonical>(
  canonical: TCanonical,
  referenceAnswer: string,
  providerResult: AiProviderResult | null,
): CatalogueDialoguePresentation<TCanonical> {
  if (providerResult === null) {
    return { canonical, answerText: referenceAnswer, answerSource: 'reference' };
  }
  if (providerResult.ok) {
    return { canonical, answerText: providerResult.dialogue, answerSource: 'ai' };
  }
  return { canonical, answerText: referenceAnswer, answerSource: 'fallback' };
}

/** One provider call at most. All failure reasons use the precomputed catalog reference. */
export async function presentCatalogueDialogue<TCanonical>(
  input: CataloguePresentationInput<TCanonical>,
): Promise<CatalogueDialoguePresentation<TCanonical>> {
  if (input.provider === null) {
    return cataloguePresentationFromResult(input.canonical, input.context.referenceAnswer, null);
  }

  let result: AiProviderResult;
  try {
    result = await input.provider.generateDialogue(input.context);
  } catch {
    result = { ok: false, reason: 'provider_error' };
  }
  return cataloguePresentationFromResult(input.canonical, input.context.referenceAnswer, result);
}

export interface FreeTextDialogueSuccess {
  readonly ok: true;
  readonly questionId: null;
  readonly answerText: string;
  readonly answerSource: 'ai';
  readonly visibility: 'actor';
  readonly engineEffect: 'none';
}

export interface FreeTextDialogueUnavailable {
  readonly ok: false;
  readonly code: 'AI_UNAVAILABLE';
  readonly questionId: null;
  readonly visibility: 'actor';
  readonly engineEffect: 'none';
}

export type FreeTextDialoguePresentation = FreeTextDialogueSuccess | FreeTextDialogueUnavailable;

export interface FreeTextPresentationInput {
  readonly context: FreeTextDialogueContext;
  readonly provider: DialogueProvider | null;
}

/** Failures expose only AI_UNAVAILABLE; no guessed question/reference or engine input exists. */
export async function presentFreeTextDialogue(
  input: FreeTextPresentationInput,
): Promise<FreeTextDialoguePresentation> {
  if (input.provider !== null) {
    try {
      const result = await input.provider.generateDialogue(input.context);
      if (result.ok) {
        return {
          ok: true,
          questionId: null,
          answerText: result.dialogue,
          answerSource: 'ai',
          visibility: 'actor',
          engineEffect: 'none',
        };
      }
    } catch {
      // The public result deliberately contains no provider detail.
    }
  }

  return {
    ok: false,
    code: 'AI_UNAVAILABLE',
    questionId: null,
    visibility: 'actor',
    engineEffect: 'none',
  };
}
