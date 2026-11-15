import {
  CreatedRoomResponseSchema,
  GameSnapshotSchema,
  PublicUserSchema,
  RoomSnapshotSchema,
  SecretReplayResponseSchema,
  SuspectDialogueSchema,
  type CreatedRoomResponse,
  type GameSnapshot,
  type PublicUser,
  type RoomSnapshot,
  type SecretReplayResponse,
  type SuspectDialogue,
} from '../src/index.js';

export const timestamps = {
  start: '2026-11-15T12:00:00.000Z',
  later: '2026-11-15T12:01:00.000Z',
  latest: '2026-11-15T12:02:00.000Z',
  tomorrow: '2026-11-16T12:00:00.000Z',
};

export const users: { host: PublicUser; guest: PublicUser } = {
  host: PublicUserSchema.parse({ id: 'user-host', displayName: 'Host' }),
  guest: PublicUserSchema.parse({ id: 'user-guest', displayName: 'Gast' }),
};

export function createRoomSnapshot(): RoomSnapshot {
  return RoomSnapshotSchema.parse({
    room: {
      id: 'room-1',
      status: 'waiting',
      version: 1,
      host: users.host,
      members: [{ user: users.host, role: 'host', joinedAt: timestamps.start }],
      maxPlayers: 4,
      activeSessionId: null,
      createdAt: timestamps.start,
      expiresAt: timestamps.tomorrow,
    },
    recentMessages: [],
    presence: [{ userId: users.host.id, status: 'online', changedAt: timestamps.start }],
  });
}

export function createCreatedRoomResponse(): CreatedRoomResponse {
  const snapshot = createRoomSnapshot();
  return CreatedRoomResponseSchema.parse({
    ...snapshot,
    outcome: 'created',
    invitation: { code: 'ABCD-EFGH-JKLM', expiresAt: timestamps.later },
  });
}

export function createSecretReplay(): SecretReplayResponse {
  return SecretReplayResponseSchema.parse({
    outcome: 'replayed',
    roomId: 'room-1',
    invitation: null,
    recovery: 'rotate_with_new_client_request_id_if_needed',
  });
}

export function createCatalogDialogue(): SuspectDialogue {
  return SuspectDialogueSchema.parse({
    id: 'dialogue-1',
    suspectId: 'suspect-1',
    mode: 'catalog',
    questionId: 'question-1',
    questionText: 'Wo waren Sie?',
    answerText: 'Im Atelier.',
    answerSource: 'reference',
    askedBy: users.host,
    createdAt: timestamps.later,
  });
}

export function createFreeTextDialogue(): SuspectDialogue {
  return SuspectDialogueSchema.parse({
    id: 'dialogue-free',
    suspectId: 'suspect-1',
    mode: 'free_text',
    questionId: null,
    questionText: 'Erzählen Sie mehr.',
    answerText: 'Dazu kann ich nichts sagen.',
    answerSource: 'ai',
    askedBy: users.host,
    createdAt: timestamps.later,
  });
}

function roomMembers() {
  return [
    { user: users.host, role: 'host', joinedAt: timestamps.start },
    { user: users.guest, role: 'member', joinedAt: timestamps.start },
  ];
}

export function createInvestigatingGameSnapshot(): GameSnapshot {
  return GameSnapshotSchema.parse({
    sessionId: 'session-1',
    roomId: 'room-1',
    caseId: 'case-1',
    caseVersion: '1.0.0',
    phase: 'investigating',
    version: 1,
    members: roomMembers(),
    suspects: [
      { id: 'suspect-1', displayName: 'Ada', publicDescription: 'Restauratorin' },
      { id: 'suspect-2', displayName: 'Ben', publicDescription: 'Kurator' },
      { id: 'suspect-3', displayName: 'Clara', publicDescription: 'Fotografin' },
    ],
    availableQuestions: [
      { questionId: 'question-1', suspectId: 'suspect-1', text: 'Wo waren Sie?' },
      { questionId: 'question-2', suspectId: 'suspect-2', text: 'Was sahen Sie?' },
      { questionId: 'question-3', suspectId: 'suspect-3', text: 'Wann kamen Sie?' },
    ],
    publicClues: [
      {
        id: 'clue-public-1',
        title: 'Öffnungszeit',
        text: 'Die Tür war um zwölf Uhr offen.',
        discoveredAt: timestamps.later,
      },
    ],
    privateClues: [
      {
        id: 'clue-private-1',
        title: 'Notiz',
        text: 'Eine persönliche Beobachtung.',
        discoveredAt: timestamps.later,
      },
    ],
    dialogues: [createCatalogDialogue()],
    finalSubmission: null,
    result: null,
    startedAt: timestamps.start,
    finishedAt: null,
  });
}

export function createCompletedGameSnapshot(): GameSnapshot {
  return GameSnapshotSchema.parse({
    ...createInvestigatingGameSnapshot(),
    phase: 'completed',
    version: 2,
    finalSubmission: {
      suspectId: 'suspect-1',
      submittedBy: users.host,
      submittedAt: timestamps.latest,
    },
    result: {
      verdict: 'correct',
      awardedPoints: 80,
      maximumPoints: 100,
      feedback: 'Die Lösung ist vollständig.',
      resolution: {
        suspectId: 'suspect-1',
        title: 'Auflösung',
        explanation: 'Die freigegebene Erklärung des Falls.',
      },
    },
    finishedAt: timestamps.latest,
  });
}

export function createAbandonedGameSnapshot(): GameSnapshot {
  return GameSnapshotSchema.parse({
    ...createInvestigatingGameSnapshot(),
    phase: 'abandoned',
    version: 2,
    finishedAt: timestamps.latest,
  });
}
