import { describe, expect, it, vi } from 'vitest';
import type {
  DialogueExecutionKey,
  DialogueExecutionPayload,
  DialogueExecutionRequest,
} from '../../src/ai/index.js';
import {
  DialogueExecutionCoordinator,
  MockDialogueProvider,
  presentCatalogueDialogue,
} from '../../src/ai/index.js';
import { catalogContext, deferred, REFERENCE_ANSWER } from './fixtures.js';

function executionKey(overrides: Partial<DialogueExecutionKey> = {}): DialogueExecutionKey {
  return {
    actorUserId: 'actor-fixture-only',
    operation: 'suspect:question',
    aggregateId: 'aggregate-fixture-only',
    clientRequestId: '00000000-0000-4000-8000-000000000501',
    ...overrides,
  };
}

function catalogPayload(
  overrides: Partial<Extract<DialogueExecutionPayload, { mode: 'catalog' }>> = {},
): DialogueExecutionPayload {
  return {
    mode: 'catalog',
    suspectId: 'jonas-kern',
    questionId: 'q-jonas-round',
    expectedVersion: 3,
    ...overrides,
  };
}

function freeTextPayload(
  overrides: Partial<Extract<DialogueExecutionPayload, { mode: 'free_text' }>> = {},
): DialogueExecutionPayload {
  return {
    mode: 'free_text',
    suspectId: 'jonas-kern',
    questionText: 'War die Galerie leer?',
    expectedVersion: 3,
    ...overrides,
  };
}

function executionRequest(
  key: DialogueExecutionKey = executionKey(),
  payload: DialogueExecutionPayload = catalogPayload(),
): DialogueExecutionRequest {
  return { key, payload };
}

function persisted<T>(value: T) {
  return { receipt: 'persisted', value } as const;
}

function absent<T>(value: T) {
  return { receipt: 'absent', value } as const;
}

describe('dialogue execution in-flight and successful replay coordination', () => {
  it('shares the exact in-flight Promise and performs one provider call', async () => {
    const coordinator = new DialogueExecutionCoordinator();
    const providerGate = deferred<Awaited<ReturnType<MockDialogueProvider['generateDialogue']>>>();
    const provider = new MockDialogueProvider(() => providerGate.promise);
    const canonical = Object.freeze({ phase: 'investigating', clueIds: ['fixed-clue'] });
    let executions = 0;
    const invoke = () =>
      coordinator.execute(executionRequest(), async () => {
        executions += 1;
        const presentation = await presentCatalogueDialogue({
          canonical,
          context: catalogContext(),
          provider,
        });
        return persisted(presentation);
      });

    const first = invoke();
    const duplicate = invoke();
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(provider.callCount).toBe(1));
    expect(executions).toBe(1);

    providerGate.resolve({ ok: true, dialogue: 'Ein gemeinsamer KI-Text.' });
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(firstResult).toEqual({
      ok: true,
      value: {
        canonical,
        answerText: 'Ein gemeinsamer KI-Text.',
        answerSource: 'ai',
      },
    });
    expect(duplicateResult).toEqual(firstResult);
    expect(provider.callCount).toBe(1);
    expect(canonical).toEqual({ phase: 'investigating', clueIds: ['fixed-clue'] });
  });

  it('reuses a persisted successful result without new execution or provider call', async () => {
    const coordinator = new DialogueExecutionCoordinator();
    const provider = new MockDialogueProvider(() => ({
      ok: true,
      dialogue: 'Gespeicherter Text.',
    }));
    const execution = vi.fn(async () => {
      const presentation = await presentCatalogueDialogue({
        canonical: { immutable: true },
        context: catalogContext(),
        provider,
      });
      return persisted(presentation);
    });

    const first = await coordinator.execute(executionRequest(), execution);
    const replay = await coordinator.execute(executionRequest(), execution);
    expect(replay).toEqual(first);
    expect(execution).toHaveBeenCalledTimes(1);
    expect(provider.callCount).toBe(1);
  });

  it.each([
    ['questionId', catalogPayload({ questionId: 'q-other-question' })],
    ['suspectId', catalogPayload({ suspectId: 'miriam-vogt' })],
    ['expectedVersion', catalogPayload({ expectedVersion: 4 })],
    ['mode', freeTextPayload()],
  ])(
    'returns IDEMPOTENCY_KEY_REUSED after success when %s changes in the same scope',
    async (_field, changedPayload) => {
      const coordinator = new DialogueExecutionCoordinator();
      const competingExecution = vi.fn(() => persisted({ shouldNotRun: true }));
      await coordinator.execute(executionRequest(), () => persisted({ canonical: 'unchanged' }));

      await expect(
        coordinator.execute(executionRequest(executionKey(), changedPayload), competingExecution),
      ).resolves.toEqual({ ok: false, code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(competingExecution).not.toHaveBeenCalled();
    },
  );

  it('rejects a changed in-flight payload immediately without mutation or another execution', async () => {
    const coordinator = new DialogueExecutionCoordinator();
    const gate = deferred<string>();
    const firstExecution = vi.fn(async () => persisted(await gate.promise));
    const competingExecution = vi.fn(() => persisted('must-not-run'));
    const first = coordinator.execute(executionRequest(), firstExecution);

    await expect(
      coordinator.execute(
        executionRequest(executionKey(), catalogPayload({ questionId: 'q-changed' })),
        competingExecution,
      ),
    ).resolves.toEqual({ ok: false, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(competingExecution).not.toHaveBeenCalled();
    expect(firstExecution).toHaveBeenCalledTimes(1);
    gate.resolve('first-only');
    await expect(first).resolves.toEqual({ ok: true, value: 'first-only' });
  });

  it('rejects changed free_text content under an already used request ID', async () => {
    const coordinator = new DialogueExecutionCoordinator();
    const original = executionRequest(executionKey(), freeTextPayload());
    const changed = executionRequest(
      executionKey(),
      freeTextPayload({ questionText: 'Abweichender Text' }),
    );
    await coordinator.execute(original, () => persisted({ questionId: null }));
    const changedExecution = vi.fn(() => persisted({ questionId: 'invented' }));

    await expect(coordinator.execute(changed, changedExecution)).resolves.toEqual({
      ok: false,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(changedExecution).not.toHaveBeenCalled();
  });

  it.each(['actorUserId', 'operation', 'aggregateId', 'clientRequestId'] as const)(
    'keeps %s as part of the idempotency scope rather than sharing another scope',
    async (field) => {
      const coordinator = new DialogueExecutionCoordinator();
      const firstKey = executionKey();
      const secondKey = executionKey({ [field]: `${firstKey[field]}-different` });
      const secondExecution = vi.fn(() => persisted('second'));

      await coordinator.execute(executionRequest(firstKey), () => persisted('first'));
      await expect(
        coordinator.execute(executionRequest(secondKey), secondExecution),
      ).resolves.toEqual({ ok: true, value: 'second' });
      expect(secondExecution).toHaveBeenCalledTimes(1);
    },
  );

  it('does not cache an uncommitted provider failure or force a retry in the same execution', async () => {
    const coordinator = new DialogueExecutionCoordinator();
    const provider = new MockDialogueProvider(() => ({ ok: false, reason: 'invalid_output' }));
    const execution = vi.fn(async () => {
      const presentation = await presentCatalogueDialogue({
        canonical: { unchanged: true },
        context: catalogContext(),
        provider,
      });
      return absent(presentation);
    });

    const first = await coordinator.execute(executionRequest(), execution);
    expect(first).toMatchObject({
      ok: true,
      value: { answerText: REFERENCE_ANSWER, answerSource: 'fallback' },
    });
    expect(execution).toHaveBeenCalledTimes(1);
    expect(provider.callCount).toBe(1);

    // A later T009 execution without success receipt may explicitly try again and counts anew.
    await coordinator.execute(executionRequest(), execution);
    expect(execution).toHaveBeenCalledTimes(2);
    expect(provider.callCount).toBe(2);
  });

  it('cleans up a rejected in-flight execution and caches neither exceptions nor failure values', async () => {
    const coordinator = new DialogueExecutionCoordinator();
    let attempts = 0;
    const execution = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('simulated CAS loss, no receipt');
      }
      return absent('fallback-not-cached');
    });

    await expect(coordinator.execute(executionRequest(), execution)).rejects.toThrow(
      'simulated CAS loss',
    );
    expect(execution).toHaveBeenCalledTimes(1);
    await expect(coordinator.execute(executionRequest(), execution)).resolves.toEqual({
      ok: true,
      value: 'fallback-not-cached',
    });
    await expect(coordinator.execute(executionRequest(), execution)).resolves.toEqual({
      ok: true,
      value: 'fallback-not-cached',
    });
    expect(execution).toHaveBeenCalledTimes(3);
  });

  it('bounds persistent-result memory by LRU eviction while leaving replay authority with T009', async () => {
    const coordinator = new DialogueExecutionCoordinator(1);
    const firstRequest = executionRequest();
    const secondRequest = executionRequest(
      executionKey({ clientRequestId: '00000000-0000-4000-8000-000000000502' }),
    );
    const firstExecution = vi.fn(() => persisted('first'));

    await coordinator.execute(firstRequest, firstExecution);
    await coordinator.execute(secondRequest, () => persisted('second'));
    await coordinator.execute(firstRequest, firstExecution);

    // The local success was evicted; a real T009 integration checks its durable receipt first.
    expect(firstExecution).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe cache bounds instead of allowing unbounded configuration', () => {
    expect(() => new DialogueExecutionCoordinator(0)).toThrow(RangeError);
    expect(() => new DialogueExecutionCoordinator(1.5)).toThrow(RangeError);
    expect(() => new DialogueExecutionCoordinator(-1)).toThrow(RangeError);
  });
});
