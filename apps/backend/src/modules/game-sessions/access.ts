import {
  RoomMemberSchema,
  type GameEvent,
  type PublicUser,
  type RoomMember,
} from '@casetogether/shared';
import type { ObjectId } from 'mongodb';
import {
  getGameSnapshot,
  type CaseDefinition,
  type GameEngineState,
} from '../../game-engine/index.js';
import type { RoomDocument } from '../rooms/persistence.js';
import type { RoomUserDirectory } from '../rooms/user-directory.js';
import { actorObjectId, applicationErrorFromEngine, notFound, parseObjectId } from './errors.js';
import { engineStateFromDocument, type GameSessionDocument } from './persistence.js';
import type {
  CaseRepository,
  GameSessionRepository,
  GameSessionRoomRepository,
} from './repository.js';

export interface AuthorizedGameContext {
  readonly actorUserId: ObjectId;
  readonly session: GameSessionDocument;
  readonly room: RoomDocument;
  readonly caseDefinition: CaseDefinition;
  readonly state: GameEngineState;
}

export class GameSessionAccess {
  constructor(
    private readonly sessions: GameSessionRepository,
    private readonly rooms: GameSessionRoomRepository,
    private readonly cases: CaseRepository,
  ) {}

  async authorize(actor: PublicUser, sessionIdInput: string): Promise<AuthorizedGameContext> {
    const actorUserId = actorObjectId(actor);
    const sessionId = parseObjectId(sessionIdInput);
    const session = await this.sessions.findById(sessionId);
    if (session === null || session.startIntent.status !== 'prepared') {
      throw notFound();
    }
    const room = await this.rooms.findVisibleById(session.roomId, actorUserId);
    if (
      room === null ||
      room.activeSessionId === null ||
      !room.activeSessionId.equals(session._id)
    ) {
      throw notFound();
    }
    const member = room.members.some((candidate) => candidate.userId.equals(actorUserId));
    if (!member) {
      throw notFound();
    }
    const caseDefinition = await this.cases.findPublishedVersion(
      session.caseId,
      session.caseVersion,
    );
    if (caseDefinition === null) {
      throw new Error('The pinned immutable case version is unavailable');
    }
    return {
      actorUserId,
      session,
      room,
      caseDefinition,
      state: engineStateFromDocument(session),
    };
  }

  snapshot(context: AuthorizedGameContext, actor: PublicUser) {
    const projected = getGameSnapshot(context.caseDefinition, context.state, actor.id);
    if (!projected.ok) {
      throw applicationErrorFromEngine(projected.error);
    }
    return projected.value;
  }
}

export async function projectRoomMembers(
  room: RoomDocument,
  users: RoomUserDirectory,
): Promise<RoomMember[]> {
  const publicUsers = await users.findPublicUsers(room.members.map((member) => member.userId));
  return room.members.map((member) => {
    const user = publicUsers.get(member.userId.toHexString());
    if (user === undefined) {
      throw new Error('Room projection could not resolve a game member');
    }
    return RoomMemberSchema.parse({
      user,
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
    });
  });
}

export function actorEvent(context: AuthorizedGameContext, eventId: string): GameEvent {
  const stored = context.session.events.find((event) => event.eventId === eventId);
  const delivery = stored?.deliveries.find(
    (candidate) => candidate.recipientUserId === context.actorUserId.toHexString(),
  );
  if (delivery?.event == null) {
    throw new Error('A committed actor event projection is missing');
  }
  return delivery.event;
}

export function requireActorMembership(state: GameEngineState, actorUserId: ObjectId): void {
  if (!state.members.some((member) => member.user.id === actorUserId.toHexString())) {
    throw notFound();
  }
}
