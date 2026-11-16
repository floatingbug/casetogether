import { randomUUID } from 'node:crypto';
import {
  CaseListDataSchema,
  EventIdSchema,
  FinalSubmissionRequestSchema,
  RoomIdSchema,
  RoomStartedEventSchema,
  SessionIdSchema,
  StartGameRequestSchema,
  UserIdSchema,
  VersionSchema,
  type CaseListData,
  type FinalSubmissionRequest,
  type GameSnapshot,
  type PublicUser,
  type RoomId,
  type StartGameRequest,
} from '@casetogether/shared';
import { ObjectId } from 'mongodb';
import { ApplicationError } from '../../application-error.js';
import {
  abandonGame,
  startGame as evaluateStart,
  submitFinalSolution,
  type AbandonGameCommand,
} from '../../game-engine/index.js';
import type { Clock } from '../identity/clock.js';
import type { RoomDocument } from '../rooms/persistence.js';
import type { RoomUserDirectory } from '../rooms/user-directory.js';
import { GameSessionAccess, projectRoomMembers } from './access.js';
import {
  actorObjectId,
  applicationErrorFromEngine,
  idempotencyKeyReused,
  invalidStateTransition,
  normalizeRequestId,
  notFound,
  operationInProgress,
  parseObjectId,
  receiptLookupKey,
  sha256,
  versionConflict,
} from './errors.js';
import {
  GAME_SESSION_SCHEMA_VERSION,
  engineStateFromDocument,
  mutationFromEngineState,
  type GameSessionDocument,
  type SessionActionReceiptDocument,
} from './persistence.js';
import {
  NoopGamePublicationPort,
  parseGamePublication,
  projectDeliveries,
  type GameActionResult,
  type GamePublicationPort,
} from './publication.js';
import { DuplicateGameSessionRoomError } from './repository.js';
import type {
  CaseRepository,
  GameSessionRepository,
  GameSessionRoomRepository,
} from './repository.js';

interface GameSessionServiceDependencies {
  sessions: GameSessionRepository;
  rooms: GameSessionRoomRepository;
  cases: CaseRepository;
  users: RoomUserDirectory;
  clock: Clock;
  publicationPort?: GamePublicationPort;
}

class KeyedSerialExecutor {
  private readonly queues = new Map<string, Promise<unknown>>();

  async run<Data>(key: string, operation: () => Promise<Data>): Promise<Data> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === current) {
        this.queues.delete(key);
      }
    }
  }
}

function startPayloadHash(roomId: ObjectId, request: StartGameRequest): string {
  return sha256({
    operation: 'room:start',
    roomId: roomId.toHexString(),
    clientRequestId: request.clientRequestId,
    caseId: request.caseId,
    expectedVersion: request.expectedVersion,
  });
}

function sessionReceipt(
  session: GameSessionDocument,
  input: {
    actorUserId: ObjectId;
    operation: SessionActionReceiptDocument['operation'];
    aggregateId: string;
    clientRequestId: string;
    payloadHash: string;
    eventId: string;
    now: Date;
  },
): SessionActionReceiptDocument {
  return {
    actorUserId: UserIdSchema.parse(input.actorUserId.toHexString()),
    operation: input.operation,
    aggregateId: SessionIdSchema.parse(input.aggregateId),
    clientRequestId: input.clientRequestId,
    payloadHash: input.payloadHash,
    lookupKey: receiptLookupKey(input),
    eventId: EventIdSchema.parse(input.eventId),
    createdAt: input.now,
  };
}

export class GameSessionService {
  private readonly access: GameSessionAccess;
  private readonly publicationPort: GamePublicationPort;
  private readonly starts = new KeyedSerialExecutor();

  constructor(private readonly dependencies: GameSessionServiceDependencies) {
    this.access = new GameSessionAccess(
      dependencies.sessions,
      dependencies.rooms,
      dependencies.cases,
    );
    this.publicationPort = dependencies.publicationPort ?? new NoopGamePublicationPort();
  }

  async listCases(): Promise<CaseListData> {
    return CaseListDataSchema.parse({
      items: await this.dependencies.cases.listPublishedSummaries(),
    });
  }

  async startGame(
    actor: PublicUser,
    roomIdInput: RoomId,
    requestInput: StartGameRequest,
  ): Promise<GameActionResult<GameSnapshot>> {
    const roomId = parseObjectId(roomIdInput);
    return this.starts.run(roomId.toHexString(), () =>
      this.startGameLocked(actor, roomId, requestInput),
    );
  }

  private async startGameLocked(
    actor: PublicUser,
    roomId: ObjectId,
    requestInput: StartGameRequest,
  ): Promise<GameActionResult<GameSnapshot>> {
    const request = StartGameRequestSchema.parse({
      ...requestInput,
      clientRequestId: normalizeRequestId(requestInput.clientRequestId),
    });
    const actorUserId = actorObjectId(actor);
    const room = await this.dependencies.rooms.findVisibleById(roomId, actorUserId);
    if (room === null) {
      throw notFound();
    }
    if (!room.hostUserId.equals(actorUserId)) {
      throwApplicationHostRequired();
    }

    const payloadHash = startPayloadHash(roomId, request);
    let session = await this.dependencies.sessions.findByRoomId(roomId);
    const linkedToExisting = session !== null && room.activeSessionId?.equals(session._id) === true;

    if (linkedToExisting && session !== null) {
      this.assertExactStartBinding(session, actorUserId, roomId, request, payloadHash);
      return this.completeVisibleStart(actor, session, room);
    }

    if (session !== null && session.startIntent.status !== 'superseded') {
      this.assertExactStartBinding(session, actorUserId, roomId, request, payloadHash);
    } else if (session !== null && room.activeSessionId !== null) {
      throw invalidStateTransition();
    }

    if (session === null || session.startIntent.status === 'superseded') {
      try {
        session = await this.initializeNewStart(
          actor,
          actorUserId,
          room,
          request,
          payloadHash,
          session,
        );
      } catch (error) {
        if (!(error instanceof DuplicateGameSessionRoomError)) {
          throw error;
        }
        const concurrent = await this.dependencies.sessions.findByRoomId(roomId);
        if (concurrent === null) {
          throw notFound();
        }
        this.assertExactStartBinding(concurrent, actorUserId, roomId, request, payloadHash);
        session = concurrent;
      }
    }

    if (session.startIntent.status === 'pending') {
      const prepared = await this.dependencies.sessions.prepareStart(
        session._id,
        request.clientRequestId,
        this.now(),
      );
      if (prepared === null) {
        const reloaded = await this.dependencies.sessions.findByRoomId(roomId);
        if (reloaded === null) {
          throw notFound();
        }
        this.assertExactStartBinding(reloaded, actorUserId, roomId, request, payloadHash);
        session = reloaded;
      } else {
        session = prepared;
      }
    }

    if (session.startIntent.status !== 'prepared') {
      throw operationInProgress();
    }

    const linkedRoom = await this.dependencies.rooms.linkPreparedSession({
      roomId,
      sessionId: session._id,
      actorUserId,
      expectedVersion: request.expectedVersion,
      now: this.now(),
    });
    if (linkedRoom === null) {
      return this.classifyFailedRoomLink(actor, actorUserId, session, roomId, request);
    }
    return this.completeVisibleStart(actor, session, linkedRoom);
  }

  private async initializeNewStart(
    actor: PublicUser,
    actorUserId: ObjectId,
    room: RoomDocument,
    request: StartGameRequest,
    payloadHash: string,
    previous: GameSessionDocument | null,
  ): Promise<GameSessionDocument> {
    const caseDefinition = await this.dependencies.cases.findLatestPublished(request.caseId);
    if (caseDefinition === null) {
      throw notFound();
    }
    const sessionId = previous?._id ?? new ObjectId();
    const now = this.now();
    const members = await projectRoomMembers(room, this.dependencies.users);
    const started = evaluateStart(caseDefinition, {
      roomId: RoomIdSchema.parse(room._id.toHexString()),
      sessionId: SessionIdSchema.parse(sessionId.toHexString()),
      roomStatus: room.status,
      roomVersion: room.version,
      members,
      actorUserId: actor.id,
      request,
      occurredAt: now.toISOString(),
    });
    if (!started.ok) {
      throw applicationErrorFromEngine(started.error);
    }
    const state = started.value.state;
    const session: GameSessionDocument = {
      _id: sessionId,
      schemaVersion: GAME_SESSION_SCHEMA_VERSION,
      roomId: room._id,
      startIntent: {
        actorUserId,
        operation: 'room:start',
        roomId: room._id,
        clientRequestId: request.clientRequestId,
        payloadHash,
        expectedRoomVersion: request.expectedVersion,
        caseId: caseDefinition.id,
        caseVersion: caseDefinition.version,
        status: 'pending',
        createdAt: now,
        preparedAt: null,
        supersededAt: null,
      },
      roomStartedEvent: RoomStartedEventSchema.parse({
        eventId: randomUUID(),
        roomId: room._id.toHexString(),
        version: VersionSchema.parse(room.version + 1),
        type: 'room.started',
        occurredAt: now.toISOString(),
        payload: { sessionId: sessionId.toHexString() },
      }),
      caseId: caseDefinition.id,
      caseVersion: caseDefinition.version,
      phase: state.phase,
      version: state.version,
      engineState: {
        sessionId: state.sessionId,
        roomId: state.roomId,
        caseId: state.caseId,
        caseVersion: state.caseVersion,
        phase: state.phase,
        version: state.version,
        members: [...state.members],
        answeredQuestions: [...state.answeredQuestions],
        revealedClues: [...state.revealedClues],
        finalSubmission: state.finalSubmission,
        result: state.result,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
      },
      dialogues: [...state.dialogues],
      events: state.events.map((event) => ({ ...event, deliveries: [...event.deliveries] })),
      actionReceipts: [],
      aiUsage: { providerAttemptsReserved: 0, attempts: [] },
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
      deleteAfter: null,
    };

    if (previous === null) {
      await this.dependencies.sessions.insertPendingStart(session);
      return session;
    }
    const replaced = await this.dependencies.sessions.replaceSupersededStart(session);
    if (replaced === null) {
      throw operationInProgress();
    }
    return replaced;
  }

  private assertExactStartBinding(
    session: GameSessionDocument,
    actorUserId: ObjectId,
    roomId: ObjectId,
    request: StartGameRequest,
    payloadHash: string,
  ): void {
    const intent = session.startIntent;
    if (
      intent.actorUserId.equals(actorUserId) &&
      intent.operation === 'room:start' &&
      intent.roomId.equals(roomId) &&
      intent.clientRequestId === request.clientRequestId
    ) {
      if (
        intent.payloadHash !== payloadHash ||
        intent.expectedRoomVersion !== request.expectedVersion ||
        intent.caseId !== request.caseId ||
        intent.caseVersion !== session.caseVersion ||
        session.caseId !== request.caseId
      ) {
        throw idempotencyKeyReused();
      }
      return;
    }
    if (session.startIntent.status === 'pending' || session.startIntent.status === 'prepared') {
      throw operationInProgress();
    }
    throw invalidStateTransition();
  }

  private async classifyFailedRoomLink(
    actor: PublicUser,
    actorUserId: ObjectId,
    session: GameSessionDocument,
    roomId: ObjectId,
    request: StartGameRequest,
  ): Promise<GameActionResult<GameSnapshot>> {
    const currentRoom = await this.dependencies.rooms.findVisibleById(roomId, actorUserId);
    if (currentRoom === null) {
      throw notFound();
    }
    if (currentRoom.activeSessionId?.equals(session._id) === true) {
      return this.completeVisibleStart(actor, session, currentRoom);
    }

    const currentSession = await this.dependencies.sessions.findById(session._id);
    if (currentSession?.startIntent.status === 'prepared') {
      await this.dependencies.sessions.supersedeStart(
        session._id,
        request.clientRequestId,
        this.now(),
      );
    }
    if (currentRoom.version !== request.expectedVersion) {
      throw versionConflict(currentRoom.version);
    }
    if (currentRoom.status !== 'ready') {
      throw invalidStateTransition();
    }
    throw operationInProgress();
  }

  private async completeVisibleStart(
    actor: PublicUser,
    session: GameSessionDocument,
    linkedRoom: RoomDocument,
  ): Promise<GameActionResult<GameSnapshot>> {
    const actorUserId = actorObjectId(actor);
    const intent = session.startIntent;
    const existingReceipt = session.actionReceipts.find(
      (receipt) =>
        receipt.operation === 'room:start' &&
        receipt.actorUserId === actor.id &&
        receipt.clientRequestId === intent.clientRequestId,
    );
    const receipt = sessionReceipt(session, {
      actorUserId,
      operation: 'room:start',
      aggregateId: session.roomId.toHexString(),
      clientRequestId: intent.clientRequestId,
      payloadHash: intent.payloadHash,
      eventId: session.roomStartedEvent.eventId,
      now: this.now(),
    });
    const completion = await this.dependencies.sessions.completeStart({
      sessionId: session._id,
      clientRequestId: intent.clientRequestId,
      receipt: existingReceipt ?? receipt,
      now: this.now(),
    });
    if (completion === null) {
      throw operationInProgress();
    }
    const committed = completion.session;
    const context = await this.access.authorize(actor, committed._id.toHexString());
    const data = this.access.snapshot(context, actor);
    if (!completion.receiptAdded) {
      return { data, publication: null };
    }
    const publication = parseGamePublication({
      kind: 'start',
      roomId: RoomIdSchema.parse(linkedRoom._id.toHexString()),
      roomEvent: committed.roomStartedEvent,
      deliveries: projectDeliveries(
        context.session.events.find((event) =>
          event.deliveries.some((delivery) => delivery.event?.type === 'game.started'),
        )?.deliveries ?? [],
      ),
    });
    await this.publicationPort.publish(publication);
    return { data, publication };
  }

  async getSession(actor: PublicUser, sessionId: string): Promise<GameSnapshot> {
    const context = await this.access.authorize(actor, sessionId);
    return this.access.snapshot(context, actor);
  }

  async submitFinalSolution(
    actor: PublicUser,
    sessionId: string,
    requestInput: FinalSubmissionRequest,
  ): Promise<GameActionResult<GameSnapshot>> {
    const request = FinalSubmissionRequestSchema.parse({
      ...requestInput,
      clientRequestId: normalizeRequestId(requestInput.clientRequestId),
    });
    let context = await this.access.authorize(actor, sessionId);
    let evaluated = submitFinalSolution(
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
      return { data: this.access.snapshot(context, actor), publication: null };
    }

    const committed = await this.dependencies.sessions.commitState(
      context.session._id,
      request.expectedVersion,
      mutationFromEngineState(context.session, evaluated.value.state, this.now()),
    );
    if (committed === null) {
      context = await this.access.authorize(actor, sessionId);
      evaluated = submitFinalSolution(
        context.caseDefinition,
        context.state,
        actor.id,
        request,
        this.now().toISOString(),
      );
      if (!evaluated.ok) {
        throw applicationErrorFromEngine(evaluated.error);
      }
      if (!evaluated.value.replayed) {
        throw versionConflict(context.session.version);
      }
      return { data: this.access.snapshot(context, actor), publication: null };
    }

    const committedContext = {
      ...context,
      session: committed,
      state: engineStateFromDocument(committed),
    };
    const data = this.access.snapshot(committedContext, actor);
    const publication = parseGamePublication({
      kind: 'events',
      roomId: RoomIdSchema.parse(committed.roomId.toHexString()),
      deliveries: projectDeliveries(evaluated.value.recipientEvents),
    });
    await this.publicationPort.publish(publication);
    return { data, publication };
  }

  /** Internal server operation only. No REST or socket command is registered for abandonment. */
  async abandonForServer(
    sessionIdInput: string,
    commandInput: Omit<AbandonGameCommand, 'occurredAt'>,
  ): Promise<GameActionResult<null>> {
    const sessionId = parseObjectId(sessionIdInput);
    const session = await this.dependencies.sessions.findById(sessionId);
    if (session === null || session.startIntent.status !== 'prepared') {
      throw notFound();
    }
    const room = await this.dependencies.rooms.findById(session.roomId);
    if (room?.activeSessionId?.equals(session._id) !== true) {
      throw notFound();
    }
    const caseDefinition = await this.dependencies.cases.findPublishedVersion(
      session.caseId,
      session.caseVersion,
    );
    if (caseDefinition === null) {
      throw new Error('The pinned immutable case version is unavailable');
    }
    const state = engineStateFromDocument(session);
    const evaluated = abandonGame(caseDefinition, state, {
      ...commandInput,
      occurredAt: this.now().toISOString(),
    });
    if (!evaluated.ok) {
      throw applicationErrorFromEngine(evaluated.error);
    }
    const committed = await this.dependencies.sessions.commitState(
      session._id,
      commandInput.expectedVersion,
      mutationFromEngineState(session, evaluated.value.state, this.now()),
    );
    if (committed === null) {
      const current = await this.dependencies.sessions.findById(sessionId);
      throw versionConflict(current?.version ?? session.version);
    }
    const publication = parseGamePublication({
      kind: 'events',
      roomId: RoomIdSchema.parse(committed.roomId.toHexString()),
      deliveries: projectDeliveries(evaluated.value.recipientEvents),
    });
    await this.publicationPort.publish(publication);
    return { data: null, publication };
  }

  private now(): Date {
    return new Date(this.dependencies.clock().getTime());
  }
}

function throwApplicationHostRequired(): never {
  throw new ApplicationError('FORBIDDEN', 'Host permission required');
}
