import { afterAll, describe, expect, it, vi } from 'vitest';
import type {
  CatalogQuestionRequest,
  FreeTextQuestionRequest,
  GameSnapshot,
  QuestionId,
} from '@casetogether/shared';
import type { AiProviderResult } from '../../src/ai/index.js';
import { MockDialogueProvider } from '../../src/ai/index.js';
import { glockenschlagIds } from '../../src/game-engine/index.js';
import type { ProviderAttemptDocument } from '../../src/modules/game-sessions/persistence.js';
import { MongoGameSessionRepository } from '../../src/modules/game-sessions/index.js';
import {
  TEST_NOW,
  createHarness,
  seedGameFixture,
  startFixtureGame,
  testRequestId,
} from '../game-sessions/support.js';
import { startMongoTestDatabase } from '../support/mongo-test-database.js';

const databaseState = await startMongoTestDatabase();
afterAll(() => databaseState.close());

function catalogRequest(
  session: Pick<GameSnapshot, 'sessionId' | 'version'>,
  questionId: QuestionId,
  sequence: number,
): CatalogQuestionRequest {
  return {
    sessionId: session.sessionId,
    clientRequestId: testRequestId(sequence),
    expectedVersion: session.version,
    suspectId: glockenschlagIds.suspects.jonas,
    mode: 'catalog',
    questionId,
  };
}

function freeTextRequest(
  session: Pick<GameSnapshot, 'sessionId' | 'version'>,
  sequence: number,
): FreeTextQuestionRequest {
  return {
    sessionId: session.sessionId,
    clientRequestId: testRequestId(sequence),
    expectedVersion: session.version,
    suspectId: glockenschlagIds.suspects.jonas,
    mode: 'free_text',
    questionText: 'Kontrollierte letzte Budgetanfrage ohne produktiven Provider.',
  };
}

describe('T010 provider budget boundary after recovery', () => {
  it('admits exactly one last execution at 59 across parallel catalog/free-text requests and never exceeds 60', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const initial = await createHarness(databaseState.database, fixture);
    const started = await startFixtureGame(initial);
    const repository = new MongoGameSessionRepository(databaseState.database);
    const storedStart = await repository.findByRoomId(fixture.roomId);
    if (storedStart === null) throw new Error('Expected persisted started session');

    const openAttempts: ProviderAttemptDocument[] = Array.from({ length: 59 }, (_, index) => ({
      attemptId: testRequestId(4000 + index),
      executionId: testRequestId(5000 + index),
      actorUserId: fixture.hostId,
      operation: index % 2 === 0 ? 'suspect:catalog' : 'suspect:free_text',
      aggregateId: started.sessionId,
      clientRequestId: testRequestId(6000 + index),
      mode: index % 2 === 0 ? 'catalog' : 'free_text',
      status: 'reserved',
      reservedAt: new Date(TEST_NOW + index * 1000),
      settledAt: null,
    }));
    await databaseState.database
      .collection('gameSessions')
      .updateOne(
        { _id: storedStart._id, version: 1 },
        { $set: { aiUsage: { providerAttemptsReserved: 59, attempts: openAttempts } } },
      );

    let releaseProvider: ((result: AiProviderResult) => void) | undefined;
    const provider = new MockDialogueProvider(
      () =>
        new Promise<AiProviderResult>((resolve) => {
          releaseProvider = resolve;
        }),
    );
    const restarted = await createHarness(databaseState.database, fixture, { provider });
    const recoveredBefore = await repository.findByRoomId(fixture.roomId);
    expect(recoveredBefore?.aiUsage.providerAttemptsReserved).toBe(59);
    expect(
      recoveredBefore?.aiUsage.attempts.every((attempt) => attempt.status === 'reserved'),
    ).toBe(true);

    const pendingOutcomes = Promise.allSettled([
      restarted.dialogue.askQuestion(
        fixture.host,
        catalogRequest(started, glockenschlagIds.questions.jonasRound, 7000),
      ),
      restarted.dialogue.askQuestion(fixture.guest, freeTextRequest(started, 7001)),
    ]);
    await vi.waitFor(() => expect(provider.callCount).toBe(1));
    await vi.waitFor(async () => {
      const current = await repository.findByRoomId(fixture.roomId);
      expect(current?.aiUsage.providerAttemptsReserved).toBe(60);
      expect(current?.aiUsage.attempts).toHaveLength(60);
    });
    if (releaseProvider === undefined) throw new Error('Expected the reserved provider execution');
    releaseProvider({ ok: true, dialogue: 'Ein einziger letzter kontrollierter Dialog.' });
    const outcomes = await pendingOutcomes;

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: { code: expect.stringMatching(/^(AI_UNAVAILABLE|VERSION_CONFLICT)$/) },
    });
    expect(provider.callCount).toBe(1);

    const current = await restarted.gameSessions.getSession(fixture.host, started.sessionId);
    const fallbackQuestion = current.availableQuestions[0];
    if (fallbackQuestion === undefined) throw new Error('Expected a remaining catalog question');
    const fallback = await restarted.dialogue.askQuestion(fixture.host, {
      ...catalogRequest(current, fallbackQuestion.questionId, 7002),
      suspectId: fallbackQuestion.suspectId,
    });
    expect(fallback.data.event.type).toBe('suspect.answered');
    if (fallback.data.event.type === 'suspect.answered') {
      expect(fallback.data.event.payload.dialogue?.answerSource).toBe('fallback');
    }
    const final = await repository.findByRoomId(fixture.roomId);
    expect(provider.callCount).toBe(1);
    expect(final?.aiUsage.providerAttemptsReserved).toBe(60);
    expect(final?.aiUsage.attempts).toHaveLength(60);
    expect(final?.version).toBe(3);
  }, 60_000);
});
