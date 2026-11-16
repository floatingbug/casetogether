import { afterAll, describe, expect, it } from 'vitest';
import {
  type CatalogQuestionRequest,
  type GameSnapshot,
  type PublicUser,
  type QuestionId,
} from '@casetogether/shared';
import { MockDialogueProvider } from '../../src/ai/index.js';
import { STILLER_GLOCKENSCHLAG_CASE, glockenschlagIds } from '../../src/game-engine/index.js';
import { MongoGameSessionRepository } from '../../src/modules/game-sessions/index.js';
import {
  createHarness,
  seedGameFixture,
  startFixtureGame,
  testRequestId,
} from '../game-sessions/support.js';
import { startMongoTestDatabase } from '../support/mongo-test-database.js';

const databaseState = await startMongoTestDatabase();
afterAll(() => databaseState.close());

interface EvidenceStep {
  readonly actor: 'host' | 'guest';
  readonly questionId: QuestionId;
}

const evidencePath: readonly EvidenceStep[] = [
  { actor: 'host', questionId: glockenschlagIds.questions.jonasTeacup },
  { actor: 'host', questionId: glockenschlagIds.questions.jonasRound },
  { actor: 'host', questionId: glockenschlagIds.questions.jonasInventory },
  { actor: 'guest', questionId: glockenschlagIds.questions.selinProgram },
  { actor: 'host', questionId: glockenschlagIds.questions.miriamTea },
  { actor: 'host', questionId: glockenschlagIds.questions.miriamConcentrate },
  { actor: 'host', questionId: glockenschlagIds.questions.selinTray },
  { actor: 'host', questionId: glockenschlagIds.questions.jonasControl },
  { actor: 'host', questionId: glockenschlagIds.questions.selinSpeech },
];

function canonical(snapshot: GameSnapshot) {
  return {
    phase: snapshot.phase,
    version: snapshot.version,
    availableQuestions: snapshot.availableQuestions,
    publicClues: snapshot.publicClues.map(({ id, title, text }) => ({ id, title, text })),
    privateClues: snapshot.privateClues.map(({ id, title, text }) => ({ id, title, text })),
    finalSubmission: snapshot.finalSubmission?.suspectId ?? null,
    result: snapshot.result,
    finishedAt: snapshot.finishedAt === null ? null : 'set',
  };
}

function catalogRequest(
  session: GameSnapshot,
  questionId: QuestionId,
  sequence: number,
): CatalogQuestionRequest {
  const question = STILLER_GLOCKENSCHLAG_CASE.questions.find(
    (candidate) => candidate.questionId === questionId,
  );
  if (question === undefined) throw new Error('Unknown QA evidence question');
  return {
    sessionId: session.sessionId,
    clientRequestId: testRequestId(sequence),
    expectedVersion: session.version,
    suspectId: question.suspectId,
    mode: 'catalog',
    questionId,
  };
}

async function runCompleteCatalogPath(provider: MockDialogueProvider | null) {
  const fixture = await seedGameFixture(databaseState.database);
  const harness = await createHarness(databaseState.database, fixture, { provider });
  let session = await startFixtureGame(harness);
  const timeline = [canonical(session)];
  const actors: Record<EvidenceStep['actor'], PublicUser> = {
    host: fixture.host,
    guest: fixture.guest,
  };

  for (const [index, step] of evidencePath.entries()) {
    const actor = actors[step.actor];
    const request = catalogRequest(session, step.questionId, 3000 + index);
    const answer = await harness.dialogue.askQuestion(actor, request);
    const replay = await harness.dialogue.askQuestion(actor, request);
    expect(replay.data).toEqual(answer.data);
    expect(replay.publication).toBeNull();
    expect(provider?.callCount ?? 0).toBe(provider === null ? 0 : index + 1);

    session = await harness.gameSessions.getSession(fixture.host, session.sessionId);
    timeline.push(canonical(session));
  }

  const finalRequest = {
    clientRequestId: testRequestId(3500),
    expectedVersion: session.version,
    suspectId: glockenschlagIds.suspects.miriam,
  };
  const completed = await harness.gameSessions.submitFinalSolution(
    fixture.guest,
    session.sessionId,
    finalRequest,
  );
  const finalReplay = await harness.gameSessions.submitFinalSolution(
    fixture.guest,
    session.sessionId,
    finalRequest,
  );
  expect(finalReplay.data).toEqual(completed.data);
  expect(finalReplay.publication).toBeNull();
  const hostFinal = await harness.gameSessions.getSession(fixture.host, session.sessionId);
  timeline.push(canonical(hostFinal));

  return {
    timeline,
    final: hostFinal,
    guest: await harness.gameSessions.getSession(fixture.guest, session.sessionId),
    stored: await new MongoGameSessionRepository(databaseState.database).findByRoomId(
      fixture.roomId,
    ),
    provider,
    harness,
  };
}

describe('T010 full catalog/provider equivalence with real MongoDB and offline doubles', () => {
  it('keeps every canonical step and the final score identical for reference, ai, failure and invalid-output fallback', async () => {
    const reference = await runCompleteCatalogPath(null);
    const ai = await runCompleteCatalogPath(
      new MockDialogueProvider(() => ({
        ok: true,
        dialogue: 'Kontrollierte KI-Formulierung ohne Engine-Eingriff.',
      })),
    );
    const providerFailure = await runCompleteCatalogPath(
      new MockDialogueProvider(() => ({ ok: false, reason: 'provider_error' })),
    );
    const invalidOutput = await runCompleteCatalogPath(
      new MockDialogueProvider(() => ({ ok: true, dialogue: '' })),
    );

    for (const candidate of [ai, providerFailure, invalidOutput]) {
      expect(candidate.timeline).toEqual(reference.timeline);
      expect(candidate.provider?.callCount).toBe(evidencePath.length);
      expect(candidate.stored?.aiUsage.providerAttemptsReserved).toBe(evidencePath.length);
      expect(candidate.stored?.aiUsage.attempts).toHaveLength(evidencePath.length);
    }

    for (const candidate of [reference, ai, providerFailure, invalidOutput]) {
      expect(candidate.final).toMatchObject({
        phase: 'completed',
        version: 11,
        result: {
          verdict: 'correct',
          awardedPoints: 100,
          maximumPoints: 100,
          resolution: { suspectId: glockenschlagIds.suspects.miriam },
        },
        finishedAt: expect.any(String),
      });
      expect(candidate.final.dialogues).toHaveLength(9);
      expect(candidate.final.privateClues).toHaveLength(2);
      expect(candidate.guest.dialogues).toHaveLength(7);
      expect(candidate.guest.privateClues).toHaveLength(0);
      expect(candidate.stored?.version).toBe(11);
      expect(candidate.stored?.engineState.answeredQuestions).toHaveLength(9);
      expect(candidate.stored?.events).toHaveLength(11);
      expect(candidate.stored?.actionReceipts).toHaveLength(11);
      expect(
        candidate.harness.publisher.publications.filter(
          (publication) => publication.kind === 'events',
        ),
      ).toHaveLength(10);
    }
    expect(reference.provider?.callCount ?? 0).toBe(0);
    expect(reference.stored?.aiUsage.providerAttemptsReserved).toBe(0);
  }, 60_000);
});
