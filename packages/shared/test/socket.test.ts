import { describe, expect, it } from 'vitest';
import {
  GameAbandonedEventSchema,
  GameCompletedEventSchema,
  GameErrorEventSchema,
  GameEventSchema,
  GameStartedEventSchema,
  HandshakeErrorDataSchema,
  RoomInvitationRotatedEventSchema,
  RoomLeaveAckSchema,
  SuspectAnsweredEventSchema,
  SuspectFreeTextAnsweredEventSchema,
  SuspectQuestionAckSchema,
  SuspectQuestionRequestSchema,
  createSocketAckSchema,
} from '../src/index.js';
import {
  createAbandonedGameSnapshot,
  createCatalogDialogue,
  createCompletedGameSnapshot,
  createFreeTextDialogue,
  createInvestigatingGameSnapshot,
  timestamps,
} from './fixtures.js';

const requestBase = {
  sessionId: 'session-1',
  clientRequestId: '123e4567-e89b-42d3-a456-426614174000',
  expectedVersion: 1,
  suspectId: 'suspect-1',
};

const apiError = {
  code: 'NOT_FOUND',
  message: 'Nicht gefunden',
  requestId: 'request-1',
};

describe('discriminated socket requests', () => {
  it('accepts exactly the catalog and free_text variants', () => {
    const catalog = { ...requestBase, mode: 'catalog', questionId: 'question-1' };
    const freeText = { ...requestBase, mode: 'free_text', questionText: 'Was ist passiert?' };
    expect(SuspectQuestionRequestSchema.parse(catalog)).toEqual(catalog);
    expect(SuspectQuestionRequestSchema.parse(freeText)).toEqual(freeText);
  });

  it('rejects fields belonging to the other dialogue mode', () => {
    expect(
      SuspectQuestionRequestSchema.safeParse({
        ...requestBase,
        mode: 'catalog',
        questionId: 'question-1',
        questionText: 'Zusatzfeld',
      }).success,
    ).toBe(false);
    expect(
      SuspectQuestionRequestSchema.safeParse({
        ...requestBase,
        mode: 'free_text',
        questionText: 'Was ist passiert?',
        questionId: 'question-1',
      }).success,
    ).toBe(false);
  });

  it('rejects client-authoritative outputs and unknown fields', () => {
    expect(
      SuspectQuestionRequestSchema.safeParse({
        ...requestBase,
        mode: 'catalog',
        questionId: 'question-1',
        answerSource: 'ai',
        verdict: 'correct',
      }).success,
    ).toBe(false);
  });
});

describe('socket acknowledgements', () => {
  it('discriminates success and safe failure acks', () => {
    const success = {
      ok: true,
      data: { roomId: 'room-1', roomVersion: 2, closed: false },
    };
    const failure = { ok: false, error: apiError };
    expect(RoomLeaveAckSchema.parse(success)).toEqual(success);
    expect(RoomLeaveAckSchema.parse(failure)).toEqual(failure);
    expect(RoomLeaveAckSchema.safeParse({ ...failure, data: success.data }).success).toBe(false);
    expect(RoomLeaveAckSchema.safeParse({ ...success, error: apiError }).success).toBe(false);
  });

  it('validates optional retry correlation and unknown ack fields', () => {
    const schema = createSocketAckSchema(GameEventSchema);
    expect(
      schema.safeParse({
        ok: false,
        error: apiError,
        clientRequestId: requestBase.clientRequestId,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ok: false,
        error: apiError,
        clientRequestId: 'not-a-uuid',
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ ok: false, error: apiError, stack: 'private stack' }).success).toBe(
      false,
    );
  });
});

describe('room and game event output', () => {
  it('keeps invitation rotation code- and hash-free', () => {
    const event = {
      eventId: 'event-1',
      roomId: 'room-1',
      version: 2,
      type: 'room.invitation_rotated',
      occurredAt: timestamps.later,
      payload: { expiresAt: timestamps.tomorrow },
    };
    expect(RoomInvitationRotatedEventSchema.parse(event)).toEqual(event);
    expect(
      RoomInvitationRotatedEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, code: 'ABCD-EFGH-JKLM' },
      }).success,
    ).toBe(false);
    expect(
      RoomInvitationRotatedEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, codeHash: 'hash' },
      }).success,
    ).toBe(false);
  });

  it('requires a full investigating version-1 snapshot in game.started', () => {
    const event = {
      eventId: 'event-start',
      sessionId: 'session-1',
      version: 1,
      type: 'game.started',
      occurredAt: timestamps.start,
      payload: { snapshot: createInvestigatingGameSnapshot() },
    };
    expect(GameStartedEventSchema.parse(event)).toEqual(event);
    expect(GameStartedEventSchema.safeParse({ ...event, version: 2 }).success).toBe(false);
    expect(
      GameStartedEventSchema.safeParse({
        ...event,
        payload: { snapshot: createCompletedGameSnapshot() },
      }).success,
    ).toBe(false);
  });

  it('allows only investigating catalog deltas in suspect.answered', () => {
    const event = {
      eventId: 'event-answer',
      sessionId: 'session-1',
      version: 2,
      type: 'suspect.answered',
      occurredAt: timestamps.later,
      payload: {
        dialogue: createCatalogDialogue(),
        newPublicClues: [],
        newPrivateClues: [],
        availableQuestions: [],
        phase: 'investigating',
      },
    };
    expect(SuspectAnsweredEventSchema.parse(event)).toEqual(event);
    expect(
      SuspectAnsweredEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, dialogue: createFreeTextDialogue() },
      }).success,
    ).toBe(false);
    expect(
      SuspectAnsweredEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, phase: 'completed' },
      }).success,
    ).toBe(false);
  });

  it('requires free-text-only actor dialogue in suspect.free_text_answered', () => {
    const event = {
      eventId: 'event-free',
      sessionId: 'session-1',
      version: 2,
      type: 'suspect.free_text_answered',
      occurredAt: timestamps.later,
      payload: { dialogue: createFreeTextDialogue() },
    };
    expect(SuspectFreeTextAnsweredEventSchema.parse(event)).toEqual(event);
    expect(
      SuspectFreeTextAnsweredEventSchema.safeParse({
        ...event,
        payload: { dialogue: createCatalogDialogue() },
      }).success,
    ).toBe(false);
  });

  it('requires a full completed snapshot including result, submission and finishedAt', () => {
    const snapshot = createCompletedGameSnapshot();
    const event = {
      eventId: 'event-completed',
      sessionId: 'session-1',
      version: 2,
      type: 'game.completed',
      occurredAt: timestamps.latest,
      payload: { snapshot },
    };
    expect(GameCompletedEventSchema.parse(event)).toEqual(event);
    expect(GameEventSchema.parse(event)).toEqual(event);
    expect(SuspectQuestionAckSchema.safeParse({ ok: true, data: { event } }).success).toBe(true);
    expect(
      GameCompletedEventSchema.safeParse({
        ...event,
        payload: { snapshot: { ...snapshot, finishedAt: null } },
      }).success,
    ).toBe(false);
    expect(
      GameCompletedEventSchema.safeParse({
        ...event,
        payload: { snapshot: { ...snapshot, result: null } },
      }).success,
    ).toBe(false);
    expect(GameCompletedEventSchema.safeParse({ ...event, version: 3 }).success).toBe(false);
  });

  it('requires a full abandoned snapshot with finishedAt and without a resolution', () => {
    const snapshot = createAbandonedGameSnapshot();
    const event = {
      eventId: 'event-abandoned',
      sessionId: 'session-1',
      version: 2,
      type: 'game.abandoned',
      occurredAt: timestamps.latest,
      payload: { snapshot },
    };
    expect(GameAbandonedEventSchema.parse(event)).toEqual(event);
    expect(GameEventSchema.parse(event)).toEqual(event);
    expect(
      GameAbandonedEventSchema.safeParse({
        ...event,
        payload: { snapshot: { ...snapshot, finishedAt: null } },
      }).success,
    ).toBe(false);
    expect(
      GameAbandonedEventSchema.safeParse({
        ...event,
        payload: { snapshot: { ...snapshot, result: createCompletedGameSnapshot().result } },
      }).success,
    ).toBe(false);
  });

  it('rejects incomplete terminal payloads and unmatched envelope identities', () => {
    const completed = createCompletedGameSnapshot();
    const event = {
      eventId: 'event-completed',
      sessionId: 'other-session',
      version: 2,
      type: 'game.completed',
      occurredAt: timestamps.latest,
      payload: { snapshot: completed },
    };
    expect(GameCompletedEventSchema.safeParse(event).success).toBe(false);
    expect(GameEventSchema.safeParse({ ...event, payload: {} }).success).toBe(false);
  });
});

describe('safe asynchronous errors', () => {
  it('validates game:error and the handshake error data without transport text', () => {
    const event = { error: apiError, clientRequestId: requestBase.clientRequestId };
    expect(GameErrorEventSchema.parse(event)).toEqual(event);
    expect(HandshakeErrorDataSchema.parse({ error: apiError })).toEqual({ error: apiError });
    expect(GameErrorEventSchema.safeParse({ ...event, prompt: 'private prompt' }).success).toBe(
      false,
    );
    expect(HandshakeErrorDataSchema.safeParse({ error: apiError, stack: 'stack' }).success).toBe(
      false,
    );
  });
});
