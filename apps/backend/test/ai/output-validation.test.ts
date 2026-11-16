import { describe, expect, it } from 'vitest';
import {
  AuthorizedDialogueContextSchema,
  DIALOGUE_TEXT_MAX_LENGTH,
  DialogueModelOutputSchema,
  parseDialogueModelOutput,
} from '../../src/ai/index.js';
import { catalogContext, freeTextContext, REFERENCE_ANSWER } from './fixtures.js';

describe('strict provider dialogue output', () => {
  it('accepts exactly dialogue, trims it and normalizes Unicode NFC', () => {
    const parsed = parseDialogueModelOutput({ dialogue: '  Cafe\u0301 am Brunnen.  ' });
    expect(parsed).toEqual({ ok: true, dialogue: 'Café am Brunnen.' });
  });

  it('accepts the exact 4000-character boundary and harmless dialogue whitespace', () => {
    const atBoundary = 'a'.repeat(DIALOGUE_TEXT_MAX_LENGTH);
    expect(DialogueModelOutputSchema.parse({ dialogue: atBoundary })).toEqual({
      dialogue: atBoundary,
    });
    expect(parseDialogueModelOutput({ dialogue: 'Erste Zeile.\nZweite\tZeile.' })).toEqual({
      ok: true,
      dialogue: 'Erste Zeile.\nZweite\tZeile.',
    });
  });

  it('normalizes a combining sequence before enforcing the boundary', () => {
    const combining = 'e\u0301'.repeat(DIALOGUE_TEXT_MAX_LENGTH);
    const parsed = DialogueModelOutputSchema.parse({ dialogue: combining });
    expect(parsed.dialogue).toHaveLength(DIALOGUE_TEXT_MAX_LENGTH);
    expect(parsed.dialogue).toBe('é'.repeat(DIALOGUE_TEXT_MAX_LENGTH));
  });

  it.each([
    ['missing object', undefined],
    ['null', null],
    ['string', '{"dialogue":"valid"}'],
    ['array', [{ dialogue: 'valid' }]],
    ['empty object', {}],
    ['wrong type', { dialogue: 42 }],
    ['null dialogue', { dialogue: null }],
    ['missing dialogue plus state', { statePatch: { phase: 'completed' } }],
  ])('rejects %s', (_name, value) => {
    expect(parseDialogueModelOutput(value)).toEqual({ ok: false, reason: 'invalid_output' });
  });

  it.each([
    ['empty', ''],
    ['only ASCII whitespace', '   '],
    ['only line breaks', '\n\t'],
    ['too long', 'a'.repeat(DIALOGUE_TEXT_MAX_LENGTH + 1)],
    ['NUL control', 'valid\u0000hidden'],
    ['unit separator control', 'valid\u001fhidden'],
    ['delete control', 'valid\u007fhidden'],
  ])('rejects %s dialogue', (_name, dialogue) => {
    expect(parseDialogueModelOutput({ dialogue })).toEqual({
      ok: false,
      reason: 'invalid_output',
    });
  });

  it.each([
    'mood',
    'id',
    'questionId',
    'clueId',
    'questions',
    'phase',
    'scoring',
    'suggestedIntent',
    'statePatches',
    'safetyFlags',
    'solution',
  ])('rejects the additional model field %s', (field) => {
    expect(parseDialogueModelOutput({ dialogue: 'Zulässiger Text', [field]: 'attack' })).toEqual({
      ok: false,
      reason: 'invalid_output',
    });
  });

  it('never treats JSON text or an OpenAI envelope itself as the model output object', () => {
    expect(parseDialogueModelOutput(JSON.stringify({ dialogue: 'Text' })).ok).toBe(false);
    expect(
      parseDialogueModelOutput({
        choices: [{ message: { content: JSON.stringify({ dialogue: 'Text' }) } }],
      }).ok,
    ).toBe(false);
  });
});

describe('authorized provider context boundary', () => {
  it('accepts and normalizes the two specified discriminated modes', () => {
    const catalog = AuthorizedDialogueContextSchema.parse(
      catalogContext({ questionText: '  Was haben Sie gesehen?  ' }),
    );
    expect(catalog).toMatchObject({
      mode: 'catalog',
      questionText: 'Was haben Sie gesehen?',
      referenceAnswer: REFERENCE_ANSWER,
      timeoutMs: 5000,
      maxOutputTokens: 600,
      language: 'de',
    });
    const freeText = AuthorizedDialogueContextSchema.parse(freeTextContext());
    expect(freeText).toMatchObject({ mode: 'free_text', referenceAnswer: null });
    expect(freeText).not.toHaveProperty('questionId');
  });

  it.each([
    ['catalog reference is null', catalogContext(), { referenceAnswer: null }],
    ['free text receives a reference', freeTextContext(), { referenceAnswer: REFERENCE_ANSWER }],
    ['non-contract timeout', catalogContext(), { timeoutMs: 4999 }],
    ['non-contract token budget', catalogContext(), { maxOutputTokens: 601 }],
    ['other language', catalogContext(), { language: 'en' }],
    ['unknown prompt version type', catalogContext(), { promptVersion: 1 }],
  ])('rejects %s', (_name, base, patch) => {
    expect(AuthorizedDialogueContextSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it.each(['userId', 'sessionId', 'questionId', 'email', 'caseTruth', 'suspectSecret', 'apiKey'])(
    'rejects the undeclared context field %s instead of forwarding it',
    (field) => {
      const candidate = { ...catalogContext(), [field]: 'must-not-cross-the-port' };
      expect(AuthorizedDialogueContextSchema.safeParse(candidate).success).toBe(false);
    },
  );
});
