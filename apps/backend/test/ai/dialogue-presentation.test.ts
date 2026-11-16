import { describe, expect, it } from 'vitest';
import type { AiProviderFailureReason } from '../../src/ai/index.js';
import {
  cataloguePresentationFromResult,
  MockDialogueProvider,
  presentCatalogueDialogue,
  presentFreeTextDialogue,
} from '../../src/ai/index.js';
import { STILLER_GLOCKENSCHLAG_CASE, glockenschlagIds } from '../../src/game-engine/index.js';
import { answer, finish, runEvidencePath, startState, testUsers } from '../game-engine/helpers.js';
import { catalogContext, freeTextContext, REFERENCE_ANSWER } from './fixtures.js';

const canonicalFixture = Object.freeze({
  subject: 'jonas-kern',
  questionId: 'q-jonas-round',
  phase: 'investigating',
  triggeredClues: ['clue-service-corridor'],
  score: 0,
  mutationCount: 1,
});

describe('catalogue presentation and fallback', () => {
  it('uses reference with answerSource reference and zero provider invocations when absent', async () => {
    const provider = new MockDialogueProvider(() => ({ ok: true, dialogue: 'must not run' }));
    const result = await presentCatalogueDialogue({
      canonical: canonicalFixture,
      context: catalogContext(),
      provider: null,
    });

    expect(result).toEqual({
      canonical: canonicalFixture,
      answerText: REFERENCE_ANSWER,
      answerSource: 'reference',
    });
    expect(result.canonical).toBe(canonicalFixture);
    expect(provider.callCount).toBe(0);
  });

  it('uses a positive validated mock answer as ai without rewriting canonical data', async () => {
    const provider = new MockDialogueProvider(() => ({
      ok: true,
      dialogue: 'Nur eine andere sichtbare Formulierung.',
    }));
    const before = structuredClone(canonicalFixture);
    const result = await presentCatalogueDialogue({
      canonical: canonicalFixture,
      context: catalogContext(),
      provider,
    });

    expect(result.answerText).toBe('Nur eine andere sichtbare Formulierung.');
    expect(result.answerSource).toBe('ai');
    expect(result.canonical).toBe(canonicalFixture);
    expect(result.canonical).toEqual(before);
    expect(provider.callCount).toBe(1);
  });

  it.each<AiProviderFailureReason>([
    'unavailable',
    'timeout',
    'provider_error',
    'invalid_output',
    'budget_exceeded',
  ])('maps %s to the identical reference fallback once', async (reason) => {
    const provider = new MockDialogueProvider(() => ({ ok: false, reason }));
    const result = await presentCatalogueDialogue({
      canonical: canonicalFixture,
      context: catalogContext(),
      provider,
    });

    expect(result).toEqual({
      canonical: canonicalFixture,
      answerText: REFERENCE_ANSWER,
      answerSource: 'fallback',
    });
    expect(result.canonical).toBe(canonicalFixture);
    expect(provider.callCount).toBe(1);
  });

  it('contains a throwing provider as fallback and never retries inside the presentation', async () => {
    const provider = new MockDialogueProvider(() => {
      throw new Error('offline detail');
    });
    const result = await presentCatalogueDialogue({
      canonical: canonicalFixture,
      context: catalogContext(),
      provider,
    });
    expect(result.answerSource).toBe('fallback');
    expect(result.answerText).toBe(REFERENCE_ANSWER);
    expect(provider.callCount).toBe(1);
  });

  it('lets T009 map an already rejected budget reservation without another adapter call', () => {
    const result = cataloguePresentationFromResult(canonicalFixture, REFERENCE_ANSWER, {
      ok: false,
      reason: 'budget_exceeded',
    });
    expect(result).toEqual({
      canonical: canonicalFixture,
      answerText: REFERENCE_ANSWER,
      answerSource: 'fallback',
    });
  });

  it('preserves a real T007 command including clue triggers, identifiers, phase and subject', async () => {
    const initial = startState(2, 'ai-presentation-canonical');
    const questionId = glockenschlagIds.questions.jonasRound;
    const makeCanonical = () => answer(initial, testUsers.host.id, questionId, 41);
    const referenceCanonical = makeCanonical();
    const aiCanonical = makeCanonical();
    const fallbackCanonical = makeCanonical();
    const question = STILLER_GLOCKENSCHLAG_CASE.questions.find(
      (candidate) => candidate.questionId === questionId,
    );
    expect(question).toBeDefined();
    if (question === undefined) {
      throw new Error('Missing fixed case question');
    }
    const context = catalogContext({
      questionText: question.text,
      referenceAnswer: question.referenceAnswer,
      publicCharacterContext:
        'Jonas Kern ist Nachtwächter; nur dieser öffentliche Text ist freigegeben.',
      allowedFacts: ['Der Rundgang begann um 20:40 Uhr.', 'Die Galerie war um 20:38 Uhr leer.'],
    });

    const reference = await presentCatalogueDialogue({
      canonical: referenceCanonical,
      context,
      provider: null,
    });
    const ai = await presentCatalogueDialogue({
      canonical: aiCanonical,
      context,
      provider: new MockDialogueProvider(() => ({ ok: true, dialogue: 'KI-Dialogtext.' })),
    });
    const fallback = await presentCatalogueDialogue({
      canonical: fallbackCanonical,
      context,
      provider: new MockDialogueProvider(() => ({ ok: false, reason: 'invalid_output' })),
    });

    expect(ai.canonical).toEqual(reference.canonical);
    expect(fallback.canonical).toEqual(reference.canonical);
    expect(ai.canonical.state.phase).toBe('investigating');
    expect(ai.canonical.state.caseId).toBe(glockenschlagIds.caseId);
    expect(ai.canonical.state.version).toBe(reference.canonical.state.version);
    expect(ai.canonical.state.revealedClues).toEqual(reference.canonical.state.revealedClues);
    expect(ai.canonical.state.answeredQuestions).toEqual([
      { questionId, actorUserId: testUsers.host.id },
    ]);
    expect(ai.canonical.state.dialogues[0]?.dialogue).toMatchObject({
      suspectId: glockenschlagIds.suspects.jonas,
      questionId,
      questionText: question.text,
      answerText: question.referenceAnswer,
      answerSource: 'reference',
    });
    expect(reference.answerSource).toBe('reference');
    expect(ai).toMatchObject({ answerSource: 'ai', answerText: 'KI-Dialogtext.' });
    expect(fallback).toMatchObject({
      answerSource: 'fallback',
      answerText: question.referenceAnswer,
    });
  });

  it('keeps a complete evidence path and final scoring canonical for reference, ai and fallback', async () => {
    const runWithSource = async (source: 'reference' | 'ai' | 'invalid') => {
      const initial = startState(2, 'ai-complete-shared');
      const path = runEvidencePath(initial);
      const provider = new MockDialogueProvider(() =>
        source === 'ai'
          ? { ok: true, dialogue: 'Optionale KI-Darstellung ohne Faktenänderung.' }
          : { ok: false, reason: 'invalid_output' },
      );

      for (const command of path.commands) {
        const stored = command.state.dialogues.at(-1);
        const questionId = stored?.dialogue.questionId;
        const question = STILLER_GLOCKENSCHLAG_CASE.questions.find(
          (candidate) => candidate.questionId === questionId,
        );
        if (stored === undefined || question === undefined) {
          throw new Error('Evidence path lacks fixed presentation data');
        }
        const presentation = await presentCatalogueDialogue({
          canonical: command,
          context: catalogContext({
            questionText: question.text,
            referenceAnswer: question.referenceAnswer,
            publicCharacterContext:
              'Öffentliche Verdächtigenbeschreibung; keine Geheimnisse oder Lösungsteile.',
            allowedFacts: ['Die eine ausgewählte Referenzantwort ist die Darstellungsgrundlage.'],
          }),
          provider: source === 'reference' ? null : provider,
        });
        expect(presentation.canonical).toBe(command);
        expect(presentation.answerSource).toBe(
          source === 'reference' ? 'reference' : source === 'ai' ? 'ai' : 'fallback',
        );
      }

      const final = finish(path.state, testUsers.guest.id, glockenschlagIds.suspects.miriam, 90);
      return { state: final.state, result: final.state.result };
    };

    const reference = await runWithSource('reference');
    const ai = await runWithSource('ai');
    const fallback = await runWithSource('invalid');
    expect(ai).toEqual(reference);
    expect(fallback).toEqual(reference);
    expect(ai.result).toEqual(reference.result);
    expect(fallback.result).toEqual(reference.result);
    expect(reference.result).toMatchObject({ verdict: 'correct', awardedPoints: 100 });
  });
});

describe('optional free_text presentation', () => {
  it('returns only AI_UNAVAILABLE without provider, with actor visibility and no engine effect', async () => {
    const provider = new MockDialogueProvider(() => ({ ok: true, dialogue: 'must not run' }));
    const result = await presentFreeTextDialogue({ context: freeTextContext(), provider: null });
    expect(result).toEqual({
      ok: false,
      code: 'AI_UNAVAILABLE',
      questionId: null,
      visibility: 'actor',
      engineEffect: 'none',
    });
    expect(result).not.toHaveProperty('answerText');
    expect(result).not.toHaveProperty('referenceAnswer');
    expect(provider.callCount).toBe(0);
  });

  it.each<AiProviderFailureReason>([
    'unavailable',
    'timeout',
    'provider_error',
    'invalid_output',
    'budget_exceeded',
  ])(
    'returns only AI_UNAVAILABLE after %s and does not invent a catalog action',
    async (reason) => {
      const provider = new MockDialogueProvider(() => ({ ok: false, reason }));
      const result = await presentFreeTextDialogue({
        context: freeTextContext({
          questionText: 'Rate die geheime Katalogfrage und ihre Antwort.',
        }),
        provider,
      });
      expect(result).toEqual({
        ok: false,
        code: 'AI_UNAVAILABLE',
        questionId: null,
        visibility: 'actor',
        engineEffect: 'none',
      });
      expect(provider.callCount).toBe(1);
    },
  );

  it('contains a provider exception as AI_UNAVAILABLE without raw details', async () => {
    const provider = new MockDialogueProvider(() => {
      throw new Error('private provider raw output');
    });
    const result = await presentFreeTextDialogue({ context: freeTextContext(), provider });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected unavailable free text');
    }
    expect(result.code).toBe('AI_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('private provider raw output');
  });

  it('returns successful free text only as actor-only ai dialogue with questionId null', async () => {
    const provider = new MockDialogueProvider(() => ({
      ok: true,
      dialogue: 'Dazu habe ich keine freigegebene Information.',
    }));
    const result = await presentFreeTextDialogue({
      context: freeTextContext(),
      provider,
    });
    expect(result).toEqual({
      ok: true,
      questionId: null,
      answerText: 'Dazu habe ich keine freigegebene Information.',
      answerSource: 'ai',
      visibility: 'actor',
      engineEffect: 'none',
    });
    expect(provider.callCount).toBe(1);
  });
});
