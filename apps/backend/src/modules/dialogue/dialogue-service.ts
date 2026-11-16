import { randomUUID } from 'node:crypto';
import {
  DialogueTextSchema,
  EventIdSchema,
  GameEventSchema,
  RoomIdSchema,
  SessionIdSchema,
  SuspectDialogueSchema,
  SuspectQuestionRequestSchema,
  UserIdSchema,
  VersionSchema,
  type CatalogQuestionRequest,
  type FreeTextQuestionRequest,
  type PublicUser,
  type SuspectQuestionAckData,
  type SuspectQuestionRequest,
} from '@casetogether/shared';
import type { ObjectId } from 'mongodb';
import {
  AI_PROVIDER_MAX_OUTPUT_TOKENS,
  AI_PROVIDER_TIMEOUT_MS,
  AuthorizedDialogueContextSchema,
  DialogueExecutionCoordinator,
  SUSPECT_DIALOGUE_PROMPT_VERSION,
  cataloguePresentationFromResult,
  type AiProviderResult,
  type AuthorizedDialogueContext,
  type DialogueExecutionSettlement,
  type DialogueProvider,
} from '../../ai/index.js';
import {
  askCatalogQuestion,
  type CaseDefinition,
  type CaseQuestionDefinition,
  type GameEngineState,
  type SuspectDefinition,
} from '../../game-engine/index.js';
import { ApplicationError } from '../../application-error.js';
import type { Clock } from '../identity/clock.js';
import { GameSessionAccess, actorEvent } from '../game-sessions/access.js';
import {
  applicationErrorFromEngine,
  idempotencyKeyReused,
  invalidStateTransition,
  normalizeRequestId,
  notFound,
  operationInProgress,
  receiptLookupKey,
  sha256,
  versionConflict,
} from '../game-sessions/errors.js';
import {
  engineStateFromDocument,
  mutationFromEngineState,
  type ProviderAttemptDocument,
  type SessionActionReceiptDocument,
} from '../game-sessions/persistence.js';
import {
  NoopGamePublicationPort,
  parseGamePublication,
  projectDeliveries,
  type GameActionResult,
  type GamePublicationPort,
} from '../game-sessions/publication.js';
import type {
  CaseRepository,
  GameSessionRepository,
  GameSessionRoomRepository,
} from '../game-sessions/repository.js';
import { applyCataloguePresentation } from './presentation.js';
import { DialogueRateLimiter } from './rate-limiter.js';

interface DialogueServiceDependencies {
  sessions: GameSessionRepository;
  rooms: GameSessionRoomRepository;
  cases: CaseRepository;
  provider: DialogueProvider | null;
  clock: Clock;
  publicationPort?: GamePublicationPort;
  coordinator?: DialogueExecutionCoordinator;
  rateLimiter?: DialogueRateLimiter;
}

type DialogueResult = GameActionResult<SuspectQuestionAckData>;

function cataloguePayloadHash(request: CatalogQuestionRequest): string {
  return sha256({
    sessionId: request.sessionId,
    mode: request.mode,
    suspectId: request.suspectId,
    questionId: request.questionId,
    clientRequestId: request.clientRequestId,
    expectedVersion: request.expectedVersion,
  });
}

function freeTextPayloadHash(request: FreeTextQuestionRequest): string {
  return sha256({
    sessionId: request.sessionId,
    mode: request.mode,
    suspectId: request.suspectId,
    questionText: request.questionText,
    clientRequestId: request.clientRequestId,
    expectedVersion: request.expectedVersion,
  });
}

function aiUnavailable(): ApplicationError {
  return new ApplicationError('AI_UNAVAILABLE', 'Optional free-text AI is unavailable');
}

export class DialogueService {
  private readonly access: GameSessionAccess;
  private readonly publicationPort: GamePublicationPort;
  private readonly coordinator: DialogueExecutionCoordinator;
  private readonly rateLimiter: DialogueRateLimiter;

  constructor(private readonly dependencies: DialogueServiceDependencies) {
    this.access = new GameSessionAccess(
      dependencies.sessions,
      dependencies.rooms,
      dependencies.cases,
    );
    this.publicationPort = dependencies.publicationPort ?? new NoopGamePublicationPort();
    this.coordinator = dependencies.coordinator ?? new DialogueExecutionCoordinator();
    this.rateLimiter = dependencies.rateLimiter ?? new DialogueRateLimiter(dependencies.clock);
  }

  async askQuestion(
    actor: PublicUser,
    requestInput: SuspectQuestionRequest,
  ): Promise<DialogueResult> {
    const request = SuspectQuestionRequestSchema.parse({
      ...requestInput,
      clientRequestId: normalizeRequestId(requestInput.clientRequestId),
    });
    // Coordinator results are never used as an authorization bypass: membership is checked first.
    await this.access.authorize(actor, request.sessionId);
    const operation = request.mode === 'catalog' ? 'suspect:catalog' : 'suspect:free_text';
    let executed = false;
    const coordinated = await this.coordinator.execute<DialogueResult>(
      {
        key: {
          actorUserId: actor.id,
          operation,
          aggregateId: request.sessionId,
          clientRequestId: request.clientRequestId,
        },
        payload:
          request.mode === 'catalog'
            ? {
                mode: 'catalog',
                suspectId: request.suspectId,
                questionId: request.questionId,
                expectedVersion: request.expectedVersion,
              }
            : {
                mode: 'free_text',
                suspectId: request.suspectId,
                questionText: request.questionText,
                expectedVersion: request.expectedVersion,
              },
      },
      () => {
        executed = true;
        return request.mode === 'catalog'
          ? this.executeCatalogue(actor, request)
          : this.executeFreeText(actor, request);
      },
    );
    if (!coordinated.ok) {
      throw idempotencyKeyReused();
    }
    return executed ? coordinated.value : { ...coordinated.value, publication: null };
  }

  private async executeCatalogue(
    actor: PublicUser,
    request: CatalogQuestionRequest,
  ): Promise<DialogueExecutionSettlement<DialogueResult>> {
    let context = await this.access.authorize(actor, request.sessionId);
    const replay = this.findReplay(
      context,
      request,
      'suspect:catalog',
      cataloguePayloadHash(request),
    );
    if (replay !== null) {
      return { receipt: 'persisted', value: replay };
    }

    let evaluated = askCatalogQuestion(
      context.caseDefinition,
      context.state,
      actor.id,
      request,
      this.now().toISOString(),
    );
    if (!evaluated.ok) {
      throw applicationErrorFromEngine(evaluated.error);
    }
    if (evaluated.value.replayed) {
      return { receipt: 'persisted', value: this.replayedEvent(context, evaluated.value.eventId) };
    }
    this.rateLimiter.consumeCatalog(actor.id, request.sessionId);

    const question = context.caseDefinition.questions.find(
      (candidate) => candidate.questionId === request.questionId,
    );
    if (question === undefined) {
      throw new ApplicationError('QUESTION_NOT_AVAILABLE', 'Catalog question is unavailable');
    }
    let providerResult: AiProviderResult | null = null;
    if (this.dependencies.provider !== null) {
      const reservation = await this.reserve(context, request, 'suspect:catalog');
      if (reservation.outcome === 'conflict') {
        throw reservation.error;
      }
      if (reservation.outcome === 'replay') {
        return { receipt: 'persisted', value: reservation.value };
      }
      if (reservation.outcome === 'budget_exhausted') {
        providerResult = { ok: false, reason: 'budget_exceeded' };
      } else {
        const providerCall = await this.callProvider(
          this.catalogueContext(context.caseDefinition, question),
        );
        await this.dependencies.sessions.settleProviderAttempt({
          sessionId: context.session._id,
          attemptId: reservation.attempt.attemptId,
          executionId: reservation.attempt.executionId,
          status: providerCall.ok ? 'succeeded' : 'failed',
          settledAt: this.now(),
        });
        providerResult = providerCall;
      }
    }

    const presentation = cataloguePresentationFromResult(
      evaluated.value,
      question.referenceAnswer,
      providerResult,
    );
    const presented = applyCataloguePresentation(
      evaluated.value,
      presentation.answerText,
      presentation.answerSource,
    );
    const committed = await this.dependencies.sessions.commitState(
      context.session._id,
      request.expectedVersion,
      mutationFromEngineState(context.session, presented.state, this.now()),
    );
    if (committed === null) {
      context = await this.access.authorize(actor, request.sessionId);
      const concurrentReplay = this.findReplay(
        context,
        request,
        'suspect:catalog',
        cataloguePayloadHash(request),
      );
      if (concurrentReplay !== null) {
        return { receipt: 'persisted', value: concurrentReplay };
      }
      if (context.session.version !== request.expectedVersion) {
        throw versionConflict(context.session.version);
      }
      evaluated = askCatalogQuestion(
        context.caseDefinition,
        context.state,
        actor.id,
        request,
        this.now().toISOString(),
      );
      if (!evaluated.ok) {
        throw applicationErrorFromEngine(evaluated.error);
      }
      if (evaluated.value.replayed) {
        return {
          receipt: 'persisted',
          value: this.replayedEvent(context, evaluated.value.eventId),
        };
      }
      throw operationInProgress();
    }

    const committedContext = {
      ...context,
      session: committed,
      state: engineStateFromDocument(committed),
    };
    const event = actorEvent(committedContext, evaluated.value.eventId);
    const publication = parseGamePublication({
      kind: 'events',
      roomId: RoomIdSchema.parse(committed.roomId.toHexString()),
      deliveries: projectDeliveries(presented.recipientEvents),
    });
    await this.publicationPort.publish(publication);
    return {
      receipt: 'persisted',
      value: { data: { event }, publication },
    };
  }

  private async executeFreeText(
    actor: PublicUser,
    request: FreeTextQuestionRequest,
  ): Promise<DialogueExecutionSettlement<DialogueResult>> {
    let context = await this.access.authorize(actor, request.sessionId);
    const replay = this.findReplay(
      context,
      request,
      'suspect:free_text',
      freeTextPayloadHash(request),
    );
    if (replay !== null) {
      return { receipt: 'persisted', value: replay };
    }
    if (context.session.version !== request.expectedVersion) {
      throw versionConflict(context.session.version);
    }
    if (context.session.phase !== 'investigating') {
      throw invalidStateTransition();
    }
    const suspect = context.caseDefinition.suspectDefinitions.find(
      (candidate) => candidate.id === request.suspectId,
    );
    if (suspect === undefined) {
      throw notFound();
    }
    if (this.dependencies.provider === null) {
      throw aiUnavailable();
    }
    this.rateLimiter.consumeFreeText(actor.id, request.sessionId);

    const reservation = await this.reserve(context, request, 'suspect:free_text');
    if (reservation.outcome === 'conflict') {
      throw reservation.error;
    }
    if (reservation.outcome === 'replay') {
      return { receipt: 'persisted', value: reservation.value };
    }
    if (reservation.outcome === 'budget_exhausted') {
      throw aiUnavailable();
    }
    const providerResult = await this.callProvider(
      this.freeTextContext(context.caseDefinition, suspect, request.questionText),
    );
    await this.dependencies.sessions.settleProviderAttempt({
      sessionId: context.session._id,
      attemptId: reservation.attempt.attemptId,
      executionId: reservation.attempt.executionId,
      status: providerResult.ok ? 'succeeded' : 'failed',
      settledAt: this.now(),
    });
    if (!providerResult.ok) {
      throw aiUnavailable();
    }

    const now = this.now();
    const actorMember = context.state.members.find((member) => member.user.id === actor.id);
    if (actorMember === undefined) {
      throw notFound();
    }
    const dialogue = SuspectDialogueSchema.parse({
      id: randomUUID(),
      suspectId: request.suspectId,
      mode: 'free_text',
      questionId: null,
      questionText: request.questionText,
      answerText: providerResult.dialogue,
      answerSource: 'ai',
      askedBy: actorMember.user,
      createdAt: now.toISOString(),
    });
    const eventId = EventIdSchema.parse(randomUUID());
    const event = GameEventSchema.parse({
      eventId,
      sessionId: request.sessionId,
      version: VersionSchema.parse(context.session.version + 1),
      type: 'suspect.free_text_answered',
      occurredAt: now.toISOString(),
      payload: { dialogue },
    });
    const nextState: GameEngineState = {
      ...context.state,
      version: event.version,
      dialogues: [
        ...context.state.dialogues,
        { actorUserId: actor.id, visibility: 'actor', dialogue },
      ],
      events: [
        ...context.state.events,
        { eventId, deliveries: [{ recipientUserId: actor.id, event }] },
      ],
    };
    const payloadHash = freeTextPayloadHash(request);
    const receipt: SessionActionReceiptDocument = {
      actorUserId: actor.id,
      operation: 'suspect:free_text',
      aggregateId: SessionIdSchema.parse(request.sessionId),
      clientRequestId: request.clientRequestId,
      payloadHash,
      lookupKey: receiptLookupKey({
        actorUserId: context.actorUserId,
        operation: 'suspect:free_text',
        aggregateId: request.sessionId,
        clientRequestId: request.clientRequestId,
      }),
      eventId,
      createdAt: now,
    };
    const mutation = mutationFromEngineState(context.session, nextState, now);
    const committed = await this.dependencies.sessions.commitState(
      context.session._id,
      request.expectedVersion,
      { ...mutation, actionReceipts: [...mutation.actionReceipts, receipt] },
    );
    if (committed === null) {
      context = await this.access.authorize(actor, request.sessionId);
      const concurrentReplay = this.findReplay(context, request, 'suspect:free_text', payloadHash);
      if (concurrentReplay !== null) {
        return { receipt: 'persisted', value: concurrentReplay };
      }
      if (context.session.version !== request.expectedVersion) {
        throw versionConflict(context.session.version);
      }
      throw operationInProgress();
    }

    const publication = parseGamePublication({
      kind: 'events',
      roomId: RoomIdSchema.parse(committed.roomId.toHexString()),
      deliveries: projectDeliveries([{ recipientUserId: actor.id, event }]),
    });
    await this.publicationPort.publish(publication);
    return {
      receipt: 'persisted',
      value: { data: { event }, publication },
    };
  }

  private findReplay(
    context: Awaited<ReturnType<GameSessionAccess['authorize']>>,
    request: CatalogQuestionRequest | FreeTextQuestionRequest,
    operation: 'suspect:catalog' | 'suspect:free_text',
    payloadHash: string,
  ): DialogueResult | null {
    const receipt = context.session.actionReceipts.find(
      (candidate) =>
        candidate.actorUserId === context.actorUserId.toHexString() &&
        candidate.operation === operation &&
        candidate.aggregateId === request.sessionId &&
        candidate.clientRequestId === request.clientRequestId,
    );
    if (receipt === undefined) {
      return null;
    }
    if (receipt.payloadHash !== payloadHash) {
      throw idempotencyKeyReused();
    }
    return this.replayedEvent(context, receipt.eventId);
  }

  private replayedEvent(
    context: Awaited<ReturnType<GameSessionAccess['authorize']>>,
    eventId: string,
  ): DialogueResult {
    return { data: { event: actorEvent(context, eventId) }, publication: null };
  }

  private async reserve(
    context: Awaited<ReturnType<GameSessionAccess['authorize']>>,
    request: CatalogQuestionRequest | FreeTextQuestionRequest,
    operation: 'suspect:catalog' | 'suspect:free_text',
  ): Promise<
    | { outcome: 'reserved'; attempt: ProviderAttemptDocument }
    | { outcome: 'budget_exhausted' }
    | { outcome: 'conflict'; error: ApplicationError }
    | { outcome: 'replay'; value: DialogueResult }
  > {
    const attempt: ProviderAttemptDocument = {
      attemptId: randomUUID(),
      executionId: randomUUID(),
      actorUserId: context.actorUserId,
      operation,
      aggregateId: SessionIdSchema.parse(request.sessionId),
      clientRequestId: request.clientRequestId,
      mode: request.mode,
      status: 'reserved',
      reservedAt: this.now(),
      settledAt: null,
    };
    const reserved = await this.dependencies.sessions.reserveProviderAttempt({
      sessionId: context.session._id,
      expectedVersion: request.expectedVersion,
      attempt,
    });
    if (reserved !== null) {
      return { outcome: 'reserved', attempt };
    }

    const current = await this.access.authorize(
      {
        id: UserIdSchema.parse(context.actorUserId.toHexString()),
        displayName: actorDisplayName(context),
      },
      request.sessionId,
    );
    const payloadHash =
      request.mode === 'catalog' ? cataloguePayloadHash(request) : freeTextPayloadHash(request);
    const concurrentReplay = this.findReplay(current, request, operation, payloadHash);
    if (concurrentReplay !== null) {
      return { outcome: 'replay', value: concurrentReplay };
    }
    if (current.session.version !== request.expectedVersion) {
      return { outcome: 'conflict', error: versionConflict(current.session.version) };
    }
    if (current.session.phase !== 'investigating') {
      return { outcome: 'conflict', error: invalidStateTransition() };
    }
    if (current.session.aiUsage.providerAttemptsReserved >= 60) {
      return { outcome: 'budget_exhausted' };
    }
    return { outcome: 'conflict', error: operationInProgress() };
  }

  private async callProvider(context: AuthorizedDialogueContext): Promise<AiProviderResult> {
    const provider = this.dependencies.provider;
    if (provider === null) {
      return { ok: false, reason: 'unavailable' };
    }
    try {
      const result = await provider.generateDialogue(
        AuthorizedDialogueContextSchema.parse(context),
      );
      if (!result.ok) {
        return result;
      }
      const dialogue = DialogueTextSchema.safeParse(result.dialogue);
      return dialogue.success
        ? { ok: true, dialogue: dialogue.data }
        : { ok: false, reason: 'invalid_output' };
    } catch {
      return { ok: false, reason: 'provider_error' };
    }
  }

  private catalogueContext(
    caseDefinition: CaseDefinition,
    question: CaseQuestionDefinition,
  ): AuthorizedDialogueContext {
    const suspect = this.suspect(caseDefinition, question.suspectId);
    return {
      mode: 'catalog',
      questionText: question.text,
      publicCharacterContext: this.publicCharacterContext(caseDefinition, suspect),
      allowedFacts: [...suspect.knownFacts, ...suspect.allowedStatements],
      referenceAnswer: question.referenceAnswer,
      language: 'de',
      promptVersion: SUSPECT_DIALOGUE_PROMPT_VERSION,
      timeoutMs: AI_PROVIDER_TIMEOUT_MS,
      maxOutputTokens: AI_PROVIDER_MAX_OUTPUT_TOKENS,
    };
  }

  private freeTextContext(
    caseDefinition: CaseDefinition,
    suspect: SuspectDefinition,
    questionText: string,
  ): AuthorizedDialogueContext {
    return {
      mode: 'free_text',
      questionText,
      publicCharacterContext: this.publicCharacterContext(caseDefinition, suspect),
      allowedFacts: [...suspect.knownFacts, ...suspect.allowedStatements],
      referenceAnswer: null,
      language: 'de',
      promptVersion: SUSPECT_DIALOGUE_PROMPT_VERSION,
      timeoutMs: AI_PROVIDER_TIMEOUT_MS,
      maxOutputTokens: AI_PROVIDER_MAX_OUTPUT_TOKENS,
    };
  }

  private suspect(caseDefinition: CaseDefinition, suspectId: string): SuspectDefinition {
    const suspect = caseDefinition.suspectDefinitions.find(
      (candidate) => candidate.id === suspectId,
    );
    if (suspect === undefined) {
      throw notFound();
    }
    return suspect;
  }

  private publicCharacterContext(
    caseDefinition: CaseDefinition,
    suspect: SuspectDefinition,
  ): string {
    const publicSuspect = caseDefinition.publicSuspects.find(
      (candidate) => candidate.id === suspect.id,
    );
    if (publicSuspect === undefined) {
      throw notFound();
    }
    return [publicSuspect.publicDescription, suspect.personality, suspect.speechStyle].join('\n');
  }

  private now(): Date {
    return new Date(this.dependencies.clock().getTime());
  }
}

function actorDisplayName(context: {
  readonly state: GameEngineState;
  readonly actorUserId: ObjectId;
}): string {
  const actor = context.state.members.find(
    (member) => member.user.id === context.actorUserId.toHexString(),
  );
  if (actor === undefined) {
    throw notFound();
  }
  return actor.user.displayName;
}
