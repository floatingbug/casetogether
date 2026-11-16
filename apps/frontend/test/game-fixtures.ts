import {
  CreatedRoomResponseSchema,
  GameSnapshotSchema,
  PublicUserSchema,
  RoomSnapshotSchema,
  SuspectAnsweredEventSchema,
  type ApiError,
  type GameSnapshot,
  type RoomSnapshot,
} from '@casetogether/shared';
import { testUser } from './fixtures';

export const secondUser = PublicUserSchema.parse({ id: 'user_fixture_2', displayName: 'Ben Test' });
export const requestUuid = '5c6088d1-710f-4d58-a1d4-8d866fa43a6d';
export const alternateRequestUuid = '151d5153-e4b5-4f96-a8b7-159885a2f52d';
export const invitationCode = 'ABCD-EFGH-JKLM';

const createdAt = '2026-11-16T10:00:00.000Z';
const answeredAt = '2026-11-16T10:01:00.000Z';
const completedAt = '2026-11-16T10:10:00.000Z';

export const hostMember = { user: testUser, role: 'host' as const, joinedAt: createdAt };
export const secondMember = { user: secondUser, role: 'member' as const, joinedAt: createdAt };

export function waitingRoomResponse() {
  return CreatedRoomResponseSchema.parse({
    outcome: 'created',
    room: {
      id: 'room_fixture',
      status: 'waiting',
      version: 1,
      host: testUser,
      members: [hostMember],
      maxPlayers: 4,
      activeSessionId: null,
      createdAt,
      expiresAt: '2026-11-16T12:00:00.000Z',
    },
    recentMessages: [],
    presence: [{ userId: testUser.id, status: 'online', changedAt: createdAt }],
    invitation: { code: invitationCode, expiresAt: '2026-11-16T11:00:00.000Z' },
  });
}

export function readyRoomSnapshot(version = 1): RoomSnapshot {
  return RoomSnapshotSchema.parse({
    room: {
      ...waitingRoomResponse().room,
      status: 'ready',
      version,
      members: [hostMember, secondMember],
    },
    recentMessages: [],
    presence: [
      { userId: testUser.id, status: 'online', changedAt: createdAt },
      { userId: secondUser.id, status: 'online', changedAt: createdAt },
    ],
  });
}

export function activeRoomSnapshot(version = 2): RoomSnapshot {
  return RoomSnapshotSchema.parse({
    room: {
      ...readyRoomSnapshot().room,
      status: 'in_progress',
      version,
      activeSessionId: 'session_fixture',
    },
    recentMessages: [],
    presence: readyRoomSnapshot().presence,
  });
}

export function investigatingGame(version = 1): GameSnapshot {
  return GameSnapshotSchema.parse({
    sessionId: 'session_fixture',
    roomId: 'room_fixture',
    caseId: 'case_fixture',
    caseVersion: '1.0.0',
    phase: 'investigating',
    version,
    members: [hostMember, secondMember],
    suspects: [
      { id: 'suspect_ada', displayName: 'Alex', publicDescription: 'Verwalter des Archivs' },
      { id: 'suspect_ben', displayName: 'Blake', publicDescription: 'Journalist auf Recherche' },
      { id: 'suspect_cyn', displayName: 'Cy', publicDescription: 'Technikerin im Nebengebäude' },
    ],
    availableQuestions: [
      {
        questionId: 'question_alibi',
        suspectId: 'suspect_ada',
        text: 'Wo waren Sie um Mitternacht?',
      },
      {
        questionId: 'question_key',
        suspectId: 'suspect_ben',
        text: 'Wer hatte Zugang zum Schlüssel?',
      },
    ],
    publicClues: [],
    privateClues: [],
    dialogues: [],
    finalSubmission: null,
    result: null,
    startedAt: createdAt,
    finishedAt: null,
  });
}

export function suspectAnsweredEvent(version = 2) {
  return SuspectAnsweredEventSchema.parse({
    eventId: `event_answered_${version}`,
    sessionId: 'session_fixture',
    version,
    type: 'suspect.answered',
    occurredAt: answeredAt,
    payload: {
      dialogue: {
        id: `dialogue_${version}`,
        suspectId: 'suspect_ada',
        mode: 'catalog',
        questionId: 'question_alibi',
        questionText: 'Wo waren Sie um Mitternacht?',
        answerText: 'Im Archiv; der Seiteneingang war verschlossen.',
        answerSource: 'reference',
        askedBy: testUser,
        createdAt: answeredAt,
      },
      newPublicClues: [
        {
          id: `public_clue_${version}`,
          title: 'Seiteneingang',
          text: 'Der Seiteneingang war zur Tatzeit verschlossen.',
          discoveredAt: answeredAt,
        },
      ],
      newPrivateClues: [
        {
          id: `private_clue_${version}`,
          title: 'Eigene Beobachtung',
          text: 'Nur die auslösende Person erhält diesen Halluzination-freien Fixture-Hinweis.',
          discoveredAt: answeredAt,
        },
      ],
      availableQuestions: [
        {
          questionId: 'question_followup',
          suspectId: 'suspect_ada',
          text: 'Wer kennt diesen Ablauf?',
        },
      ],
      phase: 'investigating',
    },
  });
}

export function completedGame(version = 3): GameSnapshot {
  return GameSnapshotSchema.parse({
    ...investigatingGame(version),
    availableQuestions: [],
    publicClues: suspectAnsweredEvent(2).payload.newPublicClues,
    privateClues: suspectAnsweredEvent(2).payload.newPrivateClues,
    dialogues: [suspectAnsweredEvent(2).payload.dialogue],
    phase: 'completed',
    finalSubmission: { suspectId: 'suspect_ada', submittedBy: testUser, submittedAt: completedAt },
    result: {
      verdict: 'correct',
      awardedPoints: 80,
      maximumPoints: 100,
      feedback: 'Die entscheidenden Abläufe wurden richtig verbunden.',
      resolution: {
        suspectId: 'suspect_ada',
        title: 'Der verschlossene Seiteneingang',
        explanation: 'Die bestätigten Server-Hinweise ergeben die vollständige fiktive Auflösung.',
      },
    },
    finishedAt: completedAt,
  });
}

export function socketSnapshot(game: GameSnapshot | null = null, room = readyRoomSnapshot()) {
  return {
    room,
    game,
    serverTime: '2026-11-16T10:11:00.000Z',
  };
}

export function ackError(code: ApiError['code'], details?: ApiError['details']) {
  return {
    ok: false,
    error: {
      code,
      message: 'Untrusted server message; not a UI key',
      requestId: 'request_socket_fixture',
      ...(details === undefined ? {} : { details }),
    },
  };
}
