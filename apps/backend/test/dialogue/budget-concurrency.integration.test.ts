import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CatalogQuestionRequest } from '@casetogether/shared';
import { SessionIdSchema } from '@casetogether/shared';
import { MockDialogueProvider } from '../../src/ai/index.js';
import { glockenschlagIds } from '../../src/game-engine/index.js';
import type { ProviderAttemptDocument } from '../../src/modules/game-sessions/persistence.js';
import { MongoGameSessionRepository } from '../../src/modules/game-sessions/index.js';
import type { GameSessionRepository } from '../../src/modules/game-sessions/index.js';
import { startMongoTestDatabase } from '../support/mongo-test-database.js';
import {
  createHarness,
  seedGameFixture,
  startFixtureGame,
  testRequestId,
} from '../game-sessions/support.js';

const databaseState = await startMongoTestDatabase();
afterAll(() => databaseState.close());

function catalog(
  session: { sessionId: string; version: number },
  sequence: number,
): CatalogQuestionRequest {
  return {
    sessionId: SessionIdSchema.parse(session.sessionId),
    clientRequestId: testRequestId(sequence),
    expectedVersion: session.version,
    suspectId: glockenschlagIds.suspects.jonas,
    mode: 'catalog',
    questionId: glockenschlagIds.questions.jonasRound,
  };
}

describe('T009 provider budget and dialogue CAS integration', () => {
  it('atomically shares at most 60 reservations across modes without changing version, engine or events', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const initial = await createHarness(databaseState.database, fixture);
    const session = await startFixtureGame(initial);
    const repository = new MongoGameSessionRepository(databaseState.database);
    const before = await repository.findByRoomId(fixture.roomId);
    if (before === null) throw new Error('Expected started session');
    const reservations = await Promise.all(
      Array.from({ length: 70 }, (_, index) => {
        const attempt: ProviderAttemptDocument = {
          attemptId: randomUUID(),
          executionId: randomUUID(),
          actorUserId: fixture.hostId,
          operation: index % 2 === 0 ? 'suspect:catalog' : 'suspect:free_text',
          aggregateId: SessionIdSchema.parse(session.sessionId),
          clientRequestId: testRequestId(1000 + index),
          mode: index % 2 === 0 ? 'catalog' : 'free_text',
          status: 'reserved',
          reservedAt: new Date(),
          settledAt: null,
        };
        return repository.reserveProviderAttempt({
          sessionId: before._id,
          expectedVersion: 1,
          attempt,
        });
      }),
    );
    expect(reservations.filter((value) => value !== null)).toHaveLength(60);
    const full = await repository.findByRoomId(fixture.roomId);
    expect(full?.aiUsage.providerAttemptsReserved).toBe(60);
    expect(full?.aiUsage.attempts).toHaveLength(60);
    expect(full?.version).toBe(before.version);
    expect(full?.phase).toBe(before.phase);
    expect(full?.engineState).toEqual(before.engineState);
    expect(full?.events).toEqual(before.events);
    expect(full?.actionReceipts).toEqual(before.actionReceipts);

    const provider = new MockDialogueProvider(() => ({
      ok: true,
      dialogue: 'Darf nicht aufgerufen werden.',
    }));
    const harness = await createHarness(databaseState.database, fixture, { provider });
    await expect(
      harness.dialogue.askQuestion(fixture.host, {
        sessionId: session.sessionId,
        clientRequestId: testRequestId(1200),
        expectedVersion: 1,
        suspectId: glockenschlagIds.suspects.jonas,
        mode: 'free_text',
        questionText: 'Diese Frage darf nicht den Provider erreichen.',
      }),
    ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(provider.callCount).toBe(0);
    const answer = await harness.dialogue.askQuestion(fixture.host, catalog(session, 1201));
    expect(answer.data.event.type).toBe('suspect.answered');
    if (answer.data.event.type === 'suspect.answered') {
      expect(answer.data.event.payload.dialogue).toMatchObject({
        answerSource: 'fallback',
        answerText: expect.stringContaining('Galerie'),
      });
    }
    expect(provider.callCount).toBe(0);
    const after = await repository.findByRoomId(fixture.roomId);
    expect(after?.aiUsage.providerAttemptsReserved).toBe(60);
    expect(after?.version).toBe(2);
  });

  it('rejects free text without a provider and unavailable catalog questions before reservation or call', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const harness = await createHarness(databaseState.database, fixture, { provider: null });
    const session = await startFixtureGame(harness);
    await expect(
      harness.dialogue.askQuestion(fixture.host, {
        sessionId: session.sessionId,
        clientRequestId: testRequestId(1300),
        expectedVersion: 1,
        suspectId: glockenschlagIds.suspects.jonas,
        mode: 'free_text',
        questionText: 'Nicht erforderlich.',
      }),
    ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    const withoutProvider = await new MongoGameSessionRepository(
      databaseState.database,
    ).findByRoomId(fixture.roomId);
    expect(withoutProvider?.aiUsage.providerAttemptsReserved).toBe(0);
    expect(withoutProvider?.version).toBe(1);
    expect(withoutProvider?.events).toHaveLength(1);

    const provider = new MockDialogueProvider(() => ({ ok: true, dialogue: 'Nicht erreichbar.' }));
    const configured = await createHarness(databaseState.database, fixture, { provider });
    await expect(
      configured.dialogue.askQuestion(fixture.host, {
        sessionId: session.sessionId,
        clientRequestId: testRequestId(1301),
        expectedVersion: 1,
        suspectId: glockenschlagIds.suspects.miriam,
        mode: 'catalog',
        questionId: glockenschlagIds.questions.miriamConcentrate,
      }),
    ).rejects.toMatchObject({ code: 'QUESTION_NOT_AVAILABLE' });
    expect(provider.callCount).toBe(0);
    expect(
      (await new MongoGameSessionRepository(databaseState.database).findByRoomId(fixture.roomId))
        ?.aiUsage.providerAttemptsReserved,
    ).toBe(0);
  });

  it('does not refund a settled provider attempt when the following domain CAS loses', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const provider = new MockDialogueProvider(() => ({
      ok: true,
      dialogue: 'Formulierung ohne CAS-Gewinn.',
    }));
    const base = new MongoGameSessionRepository(databaseState.database);
    let sessionId = '';
    let firstCommit = true;
    const sessions: GameSessionRepository = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'commitState') {
          return async (...args: Parameters<GameSessionRepository['commitState']>) => {
            if (firstCommit) {
              firstCommit = false;
              await databaseState.database
                .collection('gameSessions')
                .updateOne(
                  { _id: args[0], version: args[1] },
                  { $inc: { version: 1, 'engineState.version': 1 } },
                );
              return null;
            }
            return target.commitState(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const harness = await createHarness(databaseState.database, fixture, { provider, sessions });
    const started = await startFixtureGame(harness);
    sessionId = started.sessionId;
    await expect(
      harness.dialogue.askQuestion(fixture.host, catalog(started, 1400)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(provider.callCount).toBe(1);
    const afterLoss = await base.findByRoomId(fixture.roomId);
    expect(afterLoss?.version).toBe(2);
    expect(afterLoss?.aiUsage.providerAttemptsReserved).toBe(1);
    expect(afterLoss?.aiUsage.attempts[0]?.status).toBe('succeeded');
    expect(afterLoss?.engineState.answeredQuestions).toHaveLength(0);

    const newExecution = await harness.dialogue.askQuestion(fixture.host, {
      ...catalog({ sessionId, version: 2 }, 1401),
    });
    expect(newExecution.data.event.version).toBe(3);
    expect(provider.callCount).toBe(2);
    expect((await base.findByRoomId(fixture.roomId))?.aiUsage.providerAttemptsReserved).toBe(2);
  });

  it('lets exactly one CAS win between a catalog action and final submission on the same version', async () => {
    const fixture = await seedGameFixture(databaseState.database);
    const harness = await createHarness(databaseState.database, fixture);
    const session = await startFixtureGame(harness);
    const outcomes = await Promise.allSettled([
      harness.dialogue.askQuestion(fixture.host, catalog(session, 1500)),
      harness.gameSessions.submitFinalSolution(fixture.guest, session.sessionId, {
        clientRequestId: testRequestId(1501),
        expectedVersion: 1,
        suspectId: glockenschlagIds.suspects.miriam,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: { code: 'VERSION_CONFLICT' },
    });
    const current = await new MongoGameSessionRepository(databaseState.database).findByRoomId(
      fixture.roomId,
    );
    expect(current?.version).toBe(2);
    expect(current?.events).toHaveLength(2);
    expect(harness.publisher.publications.filter((item) => item.kind === 'events')).toHaveLength(1);
  });
});
