import { describe, expect, it } from 'vitest';
import {
  CreateRoomResponseSchema,
  GameSnapshotSchema,
  RotateInvitationResponseSchema,
  RoomSnapshotSchema,
  SuspectDialogueSchema,
} from '../src/index.js';
import {
  createAbandonedGameSnapshot,
  createCatalogDialogue,
  createCompletedGameSnapshot,
  createCreatedRoomResponse,
  createFreeTextDialogue,
  createInvestigatingGameSnapshot,
  createRoomSnapshot,
  createSecretReplay,
  timestamps,
  users,
} from './fixtures.js';

describe('room DTO invariants', () => {
  it('accepts a valid waiting snapshot', () => {
    expect(RoomSnapshotSchema.parse(createRoomSnapshot())).toEqual(createRoomSnapshot());
  });

  it.each([
    [
      {
        status: 'waiting',
        members: [
          { user: users.host, role: 'host', joinedAt: timestamps.start },
          { user: users.guest, role: 'member', joinedAt: timestamps.start },
        ],
      },
    ],
    [{ status: 'ready' }],
    [{ status: 'in_progress' }],
    [{ status: 'ready', activeSessionId: 'session-1' }],
    [{ status: 'closed', activeSessionId: 'session-1' }],
    [{ maxPlayers: 5 }],
  ])('rejects room cross-field violation %j', (patch) => {
    const snapshot = createRoomSnapshot();
    expect(
      RoomSnapshotSchema.safeParse({ ...snapshot, room: { ...snapshot.room, ...patch } }).success,
    ).toBe(false);
  });

  it('requires unique members and exactly one matching host', () => {
    const snapshot = createRoomSnapshot();
    const { room } = snapshot;
    const duplicate = { ...room.members[0], role: 'member' };
    expect(
      RoomSnapshotSchema.safeParse({
        ...snapshot,
        room: { ...room, status: 'ready', members: [...room.members, duplicate] },
      }).success,
    ).toBe(false);
    expect(
      RoomSnapshotSchema.safeParse({
        ...snapshot,
        room: { ...room, members: [{ ...room.members[0], role: 'member' }] },
      }).success,
    ).toBe(false);
    expect(
      RoomSnapshotSchema.safeParse({
        ...snapshot,
        room: { ...room, host: users.guest },
      }).success,
    ).toBe(false);
  });

  it('rejects secrets and unknown nested fields in room output', () => {
    const snapshot = createRoomSnapshot();
    expect(RoomSnapshotSchema.safeParse({ ...snapshot, invitation: null }).success).toBe(false);
    expect(
      RoomSnapshotSchema.safeParse({
        ...snapshot,
        room: { ...snapshot.room, invitation: { codeHash: 'hash' } },
      }).success,
    ).toBe(false);
    expect(
      RoomSnapshotSchema.safeParse({
        ...snapshot,
        room: {
          ...snapshot.room,
          members: [
            { ...snapshot.room.members[0], user: { ...users.host, email: 'u@example.com' } },
          ],
        },
      }).success,
    ).toBe(false);
  });
});

describe('one-time invitation responses', () => {
  it('accepts an initial created response with a valid code', () => {
    const created = createCreatedRoomResponse();
    expect(CreateRoomResponseSchema.parse(created)).toEqual(created);
  });

  it('accepts rotated only with its room and invitation', () => {
    const created = createCreatedRoomResponse();
    const rotated = {
      outcome: 'rotated',
      room: created.room,
      invitation: created.invitation,
    };
    expect(RotateInvitationResponseSchema.safeParse(rotated).success).toBe(true);
    expect(RotateInvitationResponseSchema.safeParse({ ...rotated, invitation: null }).success).toBe(
      false,
    );
  });

  it('accepts the minimal replay but never reconstructs a code or rich projection', () => {
    const replay = createSecretReplay();
    expect(CreateRoomResponseSchema.parse(replay)).toEqual(replay);
    expect(RotateInvitationResponseSchema.parse(replay)).toEqual(replay);

    const forbiddenVariants = [
      { ...replay, invitation: { code: 'ABCD-EFGH-JKLM', expiresAt: timestamps.later } },
      { ...replay, code: 'ABCD-EFGH-JKLM' },
      { ...replay, room: createRoomSnapshot().room },
      { ...replay, recentMessages: [] },
      { ...replay, presence: [] },
      { ...replay, recovery: 'return_original_code' },
    ];
    for (const variant of forbiddenVariants) {
      expect(CreateRoomResponseSchema.safeParse(variant).success).toBe(false);
      expect(RotateInvitationResponseSchema.safeParse(variant).success).toBe(false);
    }
  });
});

describe('dialogue mode and answer source invariants', () => {
  it.each(['reference', 'ai', 'fallback'] as const)('allows catalog answer source %s', (source) => {
    expect(
      SuspectDialogueSchema.safeParse({ ...createCatalogDialogue(), answerSource: source }).success,
    ).toBe(true);
  });

  it('requires a catalog question ID', () => {
    expect(
      SuspectDialogueSchema.safeParse({ ...createCatalogDialogue(), questionId: null }).success,
    ).toBe(false);
  });

  it.each(['reference', 'fallback'] as const)('rejects free-text source %s', (source) => {
    expect(
      SuspectDialogueSchema.safeParse({ ...createFreeTextDialogue(), answerSource: source })
        .success,
    ).toBe(false);
  });

  it('rejects a free-text question ID and a non-AI free-text answer', () => {
    expect(
      SuspectDialogueSchema.safeParse({ ...createFreeTextDialogue(), questionId: 'question-1' })
        .success,
    ).toBe(false);
  });
});

describe('game phase and terminal output invariants', () => {
  it('accepts fully populated investigating, completed and abandoned snapshots', () => {
    expect(GameSnapshotSchema.safeParse(createInvestigatingGameSnapshot()).success).toBe(true);
    expect(GameSnapshotSchema.safeParse(createCompletedGameSnapshot()).success).toBe(true);
    expect(GameSnapshotSchema.safeParse(createAbandonedGameSnapshot()).success).toBe(true);
  });

  it('does not allow result, final submission or finishedAt while investigating', () => {
    const investigating = createInvestigatingGameSnapshot();
    const completed = createCompletedGameSnapshot();
    expect(
      GameSnapshotSchema.safeParse({ ...investigating, result: completed.result }).success,
    ).toBe(false);
    expect(
      GameSnapshotSchema.safeParse({
        ...investigating,
        finalSubmission: completed.finalSubmission,
      }).success,
    ).toBe(false);
    expect(
      GameSnapshotSchema.safeParse({ ...investigating, finishedAt: timestamps.latest }).success,
    ).toBe(false);
  });

  it('requires all terminal completed fields and a full resolution', () => {
    const completed = createCompletedGameSnapshot();
    expect(GameSnapshotSchema.safeParse({ ...completed, result: null }).success).toBe(false);
    expect(GameSnapshotSchema.safeParse({ ...completed, finalSubmission: null }).success).toBe(
      false,
    );
    expect(GameSnapshotSchema.safeParse({ ...completed, finishedAt: null }).success).toBe(false);

    const result = completed.result;
    if (result === null) {
      throw new Error('Fixture invariant: completed result must exist');
    }
    const { resolution, ...withoutResolution } = result;
    void resolution;
    expect(GameSnapshotSchema.safeParse({ ...completed, result: withoutResolution }).success).toBe(
      false,
    );
  });

  it('rejects non-deterministic points and resolution suspects outside the case', () => {
    const completed = createCompletedGameSnapshot();
    const result = completed.result;
    if (result === null) {
      throw new Error('Fixture invariant: completed result must exist');
    }
    expect(
      GameSnapshotSchema.safeParse({
        ...completed,
        result: { ...result, awardedPoints: result.maximumPoints + 1 },
      }).success,
    ).toBe(false);
    expect(
      GameSnapshotSchema.safeParse({
        ...completed,
        result: {
          ...result,
          resolution: { ...result.resolution, suspectId: 'unknown-suspect' },
        },
      }).success,
    ).toBe(false);
  });

  it('requires finishedAt and no result for abandoned snapshots', () => {
    const abandoned = createAbandonedGameSnapshot();
    const completed = createCompletedGameSnapshot();
    expect(GameSnapshotSchema.safeParse({ ...abandoned, finishedAt: null }).success).toBe(false);
    expect(GameSnapshotSchema.safeParse({ ...abandoned, result: completed.result }).success).toBe(
      false,
    );
  });

  it('rejects duplicate IDs in all public projection arrays', () => {
    const snapshot = createInvestigatingGameSnapshot();
    const variants: unknown[] = [
      { ...snapshot, members: [snapshot.members[0], snapshot.members[0]] },
      { ...snapshot, suspects: [snapshot.suspects[0], snapshot.suspects[0], snapshot.suspects[2]] },
      {
        ...snapshot,
        availableQuestions: [snapshot.availableQuestions[0], snapshot.availableQuestions[0]],
      },
      { ...snapshot, publicClues: [snapshot.publicClues[0], snapshot.publicClues[0]] },
      { ...snapshot, privateClues: [snapshot.privateClues[0], snapshot.privateClues[0]] },
      { ...snapshot, dialogues: [snapshot.dialogues[0], snapshot.dialogues[0]] },
    ];
    for (const variant of variants) {
      expect(GameSnapshotSchema.safeParse(variant).success).toBe(false);
    }
  });

  it('requires deterministic dialogue chronology', () => {
    const snapshot = createInvestigatingGameSnapshot();
    const first = { ...createCatalogDialogue(), id: 'dialogue-a', createdAt: timestamps.later };
    const second = { ...createCatalogDialogue(), id: 'dialogue-b', createdAt: timestamps.latest };
    expect(GameSnapshotSchema.safeParse({ ...snapshot, dialogues: [second, first] }).success).toBe(
      false,
    );
    expect(GameSnapshotSchema.safeParse({ ...snapshot, dialogues: [first, second] }).success).toBe(
      true,
    );
  });

  it.each([
    'engineState',
    'startIntent',
    'actionReceipts',
    'aiUsage',
    'caseTruth',
    'passwordHash',
    'sessionIdHash',
    'providerConfig',
  ])('rejects server-only field %s in game output', (field) => {
    expect(
      GameSnapshotSchema.safeParse({ ...createInvestigatingGameSnapshot(), [field]: {} }).success,
    ).toBe(false);
  });
});
