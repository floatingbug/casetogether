import {
  RoomPresenceEventSchema,
  type PresenceMember,
  type RoomId,
  type RoomPresenceEvent,
  type UserId,
} from '@casetogether/shared';
import { systemClock, type Clock } from '../modules/identity/clock.js';

interface ConnectedMember {
  userId: UserId;
}

interface RoomPresenceState {
  roomId: RoomId;
  members: Map<string, PresenceMember>;
  connections: Map<string, ConnectedMember>;
}

export interface PresenceUpdate {
  roomId: RoomId;
  event: RoomPresenceEvent | null;
  evictedSocketIds: readonly string[];
}

export class PresenceTracker {
  private readonly clock: Clock;
  private readonly rooms = new Map<string, RoomPresenceState>();

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  synchronizeMembers(roomId: RoomId, memberIds: readonly UserId[]): PresenceUpdate {
    const state = this.rooms.get(roomId) ?? this.emptyState(roomId);
    this.rooms.set(roomId, state);
    const allowed = new Set(memberIds);
    let changed = false;
    const now = this.now();

    for (const member of [...state.members.values()]) {
      if (!allowed.has(member.userId)) {
        state.members.delete(member.userId);
        changed = true;
      }
    }
    for (const userId of allowed) {
      if (!state.members.has(userId)) {
        state.members.set(userId, { userId, status: 'offline', changedAt: now });
        changed = true;
      }
    }

    const evictedSocketIds: string[] = [];
    for (const [socketId, connection] of state.connections) {
      if (!allowed.has(connection.userId)) {
        evictedSocketIds.push(socketId);
        state.connections.delete(socketId);
        changed = true;
      }
    }

    return {
      roomId,
      event: this.eventIfChanged(roomId, state, changed),
      evictedSocketIds,
    };
  }

  snapshot(roomId: RoomId): RoomPresenceEvent | null {
    const state = this.rooms.get(roomId);
    return state === undefined ? null : this.event(roomId, state);
  }

  markOnline(roomId: RoomId, socketId: string, userId: UserId): RoomPresenceEvent | null {
    const state = this.rooms.get(roomId);
    if (state === undefined || !state.members.has(userId)) {
      throw new Error('Presence requires an authorized room membership');
    }

    const current = state.members.get(userId);
    const wasOnline =
      current?.status === 'online' &&
      [...state.connections.values()].some((connection) => connection.userId === userId);
    state.connections.set(socketId, { userId });
    if (!wasOnline || current?.status !== 'online') {
      state.members.set(userId, {
        userId,
        status: 'online',
        changedAt: this.now(),
      });
      return this.event(roomId, state);
    }
    return null;
  }

  disconnect(socketId: string): PresenceUpdate[] {
    const updates: PresenceUpdate[] = [];
    for (const state of this.rooms.values()) {
      const connection = state.connections.get(socketId);
      if (connection === undefined) {
        continue;
      }
      state.connections.delete(socketId);
      const stillOnline = [...state.connections.values()].some(
        (candidate) => candidate.userId === connection.userId,
      );
      if (!stillOnline) {
        state.members.set(connection.userId, {
          userId: connection.userId,
          status: 'offline',
          changedAt: this.now(),
        });
      }
      updates.push({
        roomId: state.roomId,
        event: stillOnline ? null : this.event(state.roomId, state),
        evictedSocketIds: [socketId],
      });
    }
    return updates;
  }

  removeRoom(roomId: RoomId): readonly string[] {
    const state = this.rooms.get(roomId);
    this.rooms.delete(roomId);
    return [...(state?.connections.keys() ?? [])];
  }

  private eventIfChanged(
    roomId: RoomId,
    state: RoomPresenceState,
    changed: boolean,
  ): RoomPresenceEvent | null {
    return changed ? this.event(roomId, state) : null;
  }

  private event(roomId: RoomId, state: RoomPresenceState): RoomPresenceEvent | null {
    if (state.members.size === 0) {
      return null;
    }
    return RoomPresenceEventSchema.parse({
      roomId,
      members: [...state.members.values()],
      emittedAt: this.now(),
    });
  }

  private emptyState(roomId: RoomId): RoomPresenceState {
    return { roomId, members: new Map(), connections: new Map() };
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
