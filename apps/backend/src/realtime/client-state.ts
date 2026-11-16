import {
  ChatMessageEventSchema,
  ChatSendAckSchema,
  GameEventSchema,
  GameSnapshotEventSchema,
  GameSnapshotSchema,
  RoomEventSchema,
  RoomJoinAckDataSchema,
  RoomJoinAckSchema,
  RoomLeaveAckSchema,
  RoomPresenceEventSchema,
  RoomSnapshotEventSchema,
  RoomSnapshotSchema,
  type ChatMessage,
  type GameEvent,
  type GameSnapshot,
  type RoomId,
  type RoomLeaveRequest,
  type RoomSnapshot,
} from '@casetogether/shared';

export interface ClientApplyResult {
  applied: boolean;
  syncRequired: boolean;
  reason: 'applied' | 'duplicate' | 'stale' | 'sync_required' | 'cleared' | 'rejected';
}

const applied = (): ClientApplyResult => ({
  applied: true,
  syncRequired: false,
  reason: 'applied',
});
const duplicate = (): ClientApplyResult => ({
  applied: false,
  syncRequired: false,
  reason: 'duplicate',
});
const stale = (): ClientApplyResult => ({ applied: false, syncRequired: false, reason: 'stale' });
const syncRequired = (): ClientApplyResult => ({
  applied: false,
  syncRequired: true,
  reason: 'sync_required',
});
const rejected = (): ClientApplyResult => ({
  applied: false,
  syncRequired: false,
  reason: 'rejected',
});

function compareChronology(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
): number {
  if (left.createdAt < right.createdAt) return -1;
  if (left.createdAt > right.createdAt) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function mergeMessages(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of [...current, ...incoming]) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort(compareChronology).slice(-50);
}

function mergeById<Item extends { id: string }>(
  current: readonly Item[],
  incoming: readonly Item[],
): Item[] {
  const byId = new Map<string, Item>();
  for (const item of [...current, ...incoming]) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

export type ReconnectCommand =
  | { type: 'retry-leave'; request: RoomLeaveRequest }
  | { type: 'join'; request: { roomId: RoomId } }
  | { type: 'none' };

export function nextReconnectCommand(options: {
  roomId?: RoomId;
  pendingLeave?: RoomLeaveRequest;
}): ReconnectCommand {
  if (options.pendingLeave !== undefined) {
    return { type: 'retry-leave', request: options.pendingLeave };
  }
  if (options.roomId !== undefined) {
    return { type: 'join', request: { roomId: options.roomId } };
  }
  return { type: 'none' };
}

export class RealtimeClientState {
  private roomState: RoomSnapshot | null = null;
  private gameState: GameSnapshot | null = null;
  private readonly roomEventIds = new Set<string>();
  private readonly gameEventIds = new Map<string, Set<string>>();

  get room(): RoomSnapshot | null {
    return this.roomState === null ? null : structuredClone(this.roomState);
  }

  get game(): GameSnapshot | null {
    return this.gameState === null ? null : structuredClone(this.gameState);
  }

  applyRoomJoinAck(input: unknown): ClientApplyResult {
    const parsed = RoomJoinAckSchema.safeParse(input);
    if (!parsed.success) return syncRequired();
    if (!parsed.data.ok) {
      const { code } = parsed.data.error;
      if (code === 'NOT_FOUND' || code === 'UNAUTHENTICATED') {
        this.clear();
        return { applied: false, syncRequired: false, reason: 'cleared' };
      }
      return code === 'VERSION_CONFLICT' ? syncRequired() : rejected();
    }
    return this.applySnapshot(parsed.data.data);
  }

  applySnapshot(input: unknown): ClientApplyResult {
    const parsed = RoomJoinAckDataSchema.safeParse(input);
    if (!parsed.success) return syncRequired();
    const data = parsed.data;
    if (
      data.game !== null &&
      (data.game.roomId !== data.room.room.id ||
        data.room.room.activeSessionId !== data.game.sessionId)
    ) {
      return syncRequired();
    }

    const currentRoom = this.roomState;
    const sameRoom = currentRoom?.room.id === data.room.room.id;
    if (sameRoom && data.room.room.version < currentRoom.room.version) return stale();

    const roomCandidate = sameRoom
      ? {
          ...data.room,
          recentMessages: mergeMessages(currentRoom.recentMessages, data.room.recentMessages),
        }
      : data.room;
    const validRoom = RoomSnapshotSchema.safeParse(roomCandidate);
    if (!validRoom.success) return syncRequired();

    if (!sameRoom) {
      this.roomEventIds.clear();
      this.gameEventIds.clear();
      this.gameState = null;
    }
    this.roomState = validRoom.data;

    if (data.game !== null) {
      const currentGame = this.gameState;
      if (
        currentGame === null ||
        currentGame.sessionId !== data.game.sessionId ||
        data.game.version >= currentGame.version
      ) {
        this.gameState = data.game;
      }
    }
    return applied();
  }

  applyRoomSnapshotEvent(input: unknown): ClientApplyResult {
    const parsed = RoomSnapshotEventSchema.safeParse(input);
    if (!parsed.success) return syncRequired();
    return this.applySnapshot({
      room: parsed.data.snapshot,
      game: null,
      serverTime: parsed.data.emittedAt,
    });
  }

  applyRoomEvent(input: unknown): ClientApplyResult {
    const parsed = RoomEventSchema.safeParse(input);
    if (!parsed.success) return syncRequired();
    const event = parsed.data;
    const current = this.roomState;
    if (current === null || current.room.id !== event.roomId) return syncRequired();
    if (this.roomEventIds.has(event.eventId)) return duplicate();
    if (event.version <= current.room.version) return stale();
    if (event.version !== current.room.version + 1) return syncRequired();

    const candidate = structuredClone(current);
    candidate.room.version = event.version;
    switch (event.type) {
      case 'room.member_joined':
        candidate.room.members.push(event.payload.member);
        candidate.room.status = 'ready';
        break;
      case 'room.member_left':
        candidate.room.members = candidate.room.members.filter(
          (member) => member.user.id !== event.payload.userId,
        );
        candidate.room.status = event.payload.status;
        break;
      case 'room.closed':
        candidate.room.status = 'closed';
        break;
      case 'room.invitation_rotated':
        break;
      case 'room.started':
        candidate.room.status = 'in_progress';
        candidate.room.activeSessionId = event.payload.sessionId;
        break;
    }
    const valid = RoomSnapshotSchema.safeParse(candidate);
    if (!valid.success) return syncRequired();
    this.roomState = valid.data;
    this.rememberRoomEvent(event.eventId);
    return applied();
  }

  applyRoomPresence(input: unknown): ClientApplyResult {
    const parsed = RoomPresenceEventSchema.safeParse(input);
    if (!parsed.success || this.roomState === null) return syncRequired();
    if (parsed.data.roomId !== this.roomState.room.id) return stale();
    const currentMemberIds = this.roomState.room.members.map((member) => member.user.id).sort();
    const presenceMemberIds = parsed.data.members.map((member) => member.userId).sort();
    if (JSON.stringify(currentMemberIds) !== JSON.stringify(presenceMemberIds)) {
      return syncRequired();
    }
    this.roomState = { ...this.roomState, presence: parsed.data.members };
    return applied();
  }

  applyChatMessage(input: unknown): ClientApplyResult {
    const parsed = ChatMessageEventSchema.safeParse(input);
    if (!parsed.success || this.roomState === null) return syncRequired();
    if (parsed.data.message.roomId !== this.roomState.room.id) return stale();
    const duplicateMessage = this.roomState.recentMessages.some(
      (message) => message.id === parsed.data.message.id,
    );
    if (duplicateMessage) return duplicate();
    const recentMessages = mergeMessages(this.roomState.recentMessages, [parsed.data.message]);
    const candidate = { ...this.roomState, recentMessages };
    const valid = RoomSnapshotSchema.safeParse(candidate);
    if (!valid.success) return syncRequired();
    this.roomState = valid.data;
    return applied();
  }

  applyChatAck(input: unknown): ClientApplyResult {
    const parsed = ChatSendAckSchema.safeParse(input);
    if (!parsed.success) return syncRequired();
    if (!parsed.data.ok) return rejected();
    return this.applyChatMessage({ message: parsed.data.data.message });
  }

  applyRoomLeaveAck(input: unknown): ClientApplyResult {
    const parsed = RoomLeaveAckSchema.safeParse(input);
    if (!parsed.success) return syncRequired();
    if (!parsed.data.ok) {
      const { code } = parsed.data.error;
      if (code === 'VERSION_CONFLICT') return syncRequired();
      if (code === 'NOT_FOUND' || code === 'UNAUTHENTICATED') {
        this.clear();
        return { applied: false, syncRequired: false, reason: 'cleared' };
      }
      return rejected();
    }

    const receipt = parsed.data.data;
    const current = this.roomState;
    if (current === null || current.room.id !== receipt.roomId) return stale();
    if (receipt.roomVersion < current.room.version) return stale();
    if (!receipt.closed) {
      this.clear();
      return { applied: true, syncRequired: false, reason: 'cleared' };
    }
    const candidate = structuredClone(current);
    candidate.room.version = receipt.roomVersion;
    candidate.room.status = 'closed';
    const valid = RoomSnapshotSchema.safeParse(candidate);
    if (!valid.success) return syncRequired();
    this.roomState = valid.data;
    return applied();
  }

  applyGameSnapshotEvent(input: unknown): ClientApplyResult {
    const parsed = GameSnapshotEventSchema.safeParse(input);
    if (!parsed.success) return syncRequired();
    return this.replaceGameSnapshot(parsed.data.snapshot);
  }

  applyGameEvent(input: unknown): ClientApplyResult {
    const parsed = GameEventSchema.safeParse(input);
    if (!parsed.success) return syncRequired();
    const event = parsed.data;
    const current = this.gameState;
    if (current === null && event.type !== 'game.started') return syncRequired();
    if (
      current !== null &&
      current.sessionId !== event.sessionId &&
      event.type !== 'game.started'
    ) {
      return syncRequired();
    }
    if (this.gameEventIds.get(event.sessionId)?.has(event.eventId) === true) return duplicate();
    if (current !== null && current.sessionId === event.sessionId) {
      if (event.version <= current.version) return stale();
      if (event.version !== current.version + 1) return syncRequired();
    }

    if (
      event.type === 'game.started' ||
      event.type === 'game.completed' ||
      event.type === 'game.abandoned'
    ) {
      const result = this.replaceGameSnapshot(event.payload.snapshot);
      if (result.applied || result.reason === 'stale') {
        this.rememberGameEvent(event);
      }
      return result;
    }
    return this.applyGameDelta(event);
  }

  clear(): void {
    this.roomState = null;
    this.gameState = null;
    this.roomEventIds.clear();
    this.gameEventIds.clear();
  }

  private replaceGameSnapshot(snapshot: GameSnapshot): ClientApplyResult {
    if (
      this.roomState !== null &&
      (snapshot.roomId !== this.roomState.room.id ||
        this.roomState.room.activeSessionId !== snapshot.sessionId)
    ) {
      return syncRequired();
    }
    const current = this.gameState;
    if (
      current !== null &&
      current.sessionId === snapshot.sessionId &&
      snapshot.version < current.version
    ) {
      return stale();
    }
    this.gameState = snapshot;
    return applied();
  }

  private applyGameDelta(
    event: Extract<GameEvent, { type: 'suspect.answered' | 'suspect.free_text_answered' }>,
  ): ClientApplyResult {
    const current = this.gameState;
    if (
      current === null ||
      current.sessionId !== event.sessionId ||
      current.phase !== 'investigating'
    ) {
      return syncRequired();
    }
    const candidate = structuredClone(current);
    candidate.version = event.version;
    if (event.type === 'suspect.answered') {
      candidate.availableQuestions = event.payload.availableQuestions;
      candidate.publicClues = mergeById(candidate.publicClues, event.payload.newPublicClues);
      candidate.privateClues = mergeById(candidate.privateClues, event.payload.newPrivateClues);
      if (event.payload.dialogue !== null) {
        candidate.dialogues = mergeById(candidate.dialogues, [event.payload.dialogue]).sort(
          compareChronology,
        );
      }
    } else {
      candidate.dialogues = mergeById(candidate.dialogues, [event.payload.dialogue]).sort(
        compareChronology,
      );
    }

    const valid = GameSnapshotSchema.safeParse(candidate);
    if (!valid.success) return syncRequired();
    this.gameState = valid.data;
    this.rememberGameEvent(event);
    return applied();
  }

  private rememberRoomEvent(eventId: string): void {
    this.rememberBounded(this.roomEventIds, eventId);
  }

  private rememberGameEvent(event: GameEvent): void {
    const ids = this.gameEventIds.get(event.sessionId) ?? new Set<string>();
    this.gameEventIds.set(event.sessionId, ids);
    this.rememberBounded(ids, event.eventId);
  }

  private rememberBounded(ids: Set<string>, id: string): void {
    if (ids.size >= 2048) {
      const oldest = ids.values().next().value;
      if (typeof oldest === 'string') ids.delete(oldest);
    }
    ids.add(id);
  }
}
