import { z } from 'zod';

export const AI_PROVIDER_TIMEOUT_MS = 5000 as const;
export const AI_PROVIDER_MAX_OUTPUT_TOKENS = 600 as const;
export const DIALOGUE_TEXT_MAX_LENGTH = 4000;

function hasDisallowedControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 8 ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127)
    ) {
      return true;
    }
  }
  return false;
}

const normalizedText = (maximumLength: number) =>
  z
    .string()
    .transform((value) => value.trim().normalize('NFC'))
    .pipe(z.string().min(1).max(maximumLength));

const normalizedRequiredText = z
  .string()
  .transform((value) => value.trim().normalize('NFC'))
  .pipe(z.string().min(1));

export const DialogueModelTextSchema = normalizedText(DIALOGUE_TEXT_MAX_LENGTH).refine(
  (value) => !hasDisallowedControlCharacter(value),
  'Dialogue contains a disallowed control character',
);

/** The only accepted model value. Provider envelope metadata never enters this schema. */
export const DialogueModelOutputSchema = z
  .object({
    dialogue: DialogueModelTextSchema,
  })
  .strict();

export type DialogueModelOutput = z.infer<typeof DialogueModelOutputSchema>;

export const AiProviderFailureReasonSchema = z.enum([
  'unavailable',
  'timeout',
  'provider_error',
  'invalid_output',
  'budget_exceeded',
]);

export type AiProviderFailureReason = z.infer<typeof AiProviderFailureReasonSchema>;

export type AiProviderResult =
  | { readonly ok: true; readonly dialogue: string }
  | { readonly ok: false; readonly reason: AiProviderFailureReason };

interface AuthorizedDialogueContextBase {
  readonly questionText: string;
  readonly publicCharacterContext: string;
  readonly allowedFacts: string[];
  readonly language: 'de';
  readonly promptVersion: string;
  readonly timeoutMs: typeof AI_PROVIDER_TIMEOUT_MS;
  readonly maxOutputTokens: typeof AI_PROVIDER_MAX_OUTPUT_TOKENS;
}

/** Server-curated input only. Actor/session IDs and secret case or auth data are not fields. */
export interface CatalogDialogueContext extends AuthorizedDialogueContextBase {
  readonly mode: 'catalog';
  readonly referenceAnswer: string;
}

/** Free text deliberately has no question ID and never receives a catalog reference answer. */
export interface FreeTextDialogueContext extends AuthorizedDialogueContextBase {
  readonly mode: 'free_text';
  readonly referenceAnswer: null;
}

export type AuthorizedDialogueContext = CatalogDialogueContext | FreeTextDialogueContext;

export interface DialogueProvider {
  generateDialogue(context: AuthorizedDialogueContext): Promise<AiProviderResult>;
}

const contextFields = {
  questionText: normalizedText(500),
  publicCharacterContext: normalizedRequiredText,
  allowedFacts: z.array(normalizedRequiredText),
  language: z.literal('de'),
  promptVersion: normalizedRequiredText,
  timeoutMs: z.literal(AI_PROVIDER_TIMEOUT_MS),
  maxOutputTokens: z.literal(AI_PROVIDER_MAX_OUTPUT_TOKENS),
} satisfies z.ZodRawShape;

const catalogContextSchema = z
  .object({
    ...contextFields,
    mode: z.literal('catalog'),
    referenceAnswer: DialogueModelTextSchema,
  })
  .strict();

const freeTextContextSchema = z
  .object({
    ...contextFields,
    mode: z.literal('free_text'),
    referenceAnswer: z.null(),
  })
  .strict();

/** Runtime guard for values crossing into the adapter, including malformed test doubles. */
export const AuthorizedDialogueContextSchema: z.ZodType<AuthorizedDialogueContext> =
  z.discriminatedUnion('mode', [catalogContextSchema, freeTextContextSchema]);

export type ParsedDialogueModelOutput =
  | { readonly ok: true; readonly dialogue: string }
  | { readonly ok: false; readonly reason: 'invalid_output' };

export function parseDialogueModelOutput(value: unknown): ParsedDialogueModelOutput {
  const parsed = DialogueModelOutputSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_output' };
  }
  return { ok: true, dialogue: parsed.data.dialogue };
}
