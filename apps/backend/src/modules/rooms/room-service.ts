import {
  CreateRoomResponseSchema,
  RoomIdSchema,
  RoomInvitationRotatedEventSchema,
  RoomClosedEventSchema,
  RoomMemberJoinedEventSchema,
  RoomMemberLeftEventSchema,
  RoomSnapshotSchema,
  RotateInvitationResponseSchema,
  SecretReplayResponseSchema,
  UserIdSchema,
  type ClientRequest,
  type CreateRoomResponse,
  type JoinRoomRequest,
  type PublicUser,
  type RotateInvitationRequest,
  type RotateInvitationResponse,
  type RoomEvent,
  type RoomId,
  type RoomLeaveAckData,
  type RoomLeaveRequest,
  type RoomSnapshot,
  type SecretReplayResponse,
  type UserId,
} from '@casetogether/shared';
import { ObjectId, type Db } from 'mongodb';
import { ApplicationError } from '../../application-error.js';
import { ensureRoomIndexes } from '../../database/room-indexes.js';
import { systemClock, type Clock } from '../identity/clock.js';
import {
  createRoomPayloadHash,
  joinRoomPayloadHash,
  normalizeClientRequestId,
  roomReceiptLookupKey,
  versionedRoomPayloadHash,
} from './idempotency.js';
import {
  canonicalizeInvitationCode,
  generateInvitationCode,
  hashInvitationCode,
  INVITATION_TTL_MS,
  LOBBY_TTL_MS,
  type InvitationCodeGenerator,
} from './invitation.js';
import { JoinRateLimiter } from './join-rate-limiter.js';
import { MongoRoomRepository } from './mongo-room-repository.js';
import {
  ROOM_MAX_PLAYERS,
  ROOM_SCHEMA_VERSION,
  RoomDocumentSchema,
  type RoomDocument,
} from './persistence.js';
import {
  DuplicateInvitationCodeError,
  DuplicateRoomReceiptError,
  type JoinMutationInput,
  type ReceiptMatch,
  type RoomRepository,
} from './repository.js';
import { MongoRoomUserDirectory, type RoomUserDirectory } from './user-directory.js';

const CREATE_OPERATION = 'create';
const JOIN_OPERATION = 'join';
const ROTATE_OPERATION = 'rotate';
const LEAVE_OPERATION = 'leave';
const CREATE_AGGREGATE_ID = 'new';
const INVITATION_GENERATION_ATTEMPTS = 8;

export interface RoomPublication {
  recipientUserIds: readonly UserId[];
  event: RoomEvent;
}

export interface RoomActionResult<Data> {
  data: Data;
  publication: RoomPublication | null;
}

interface RoomServiceDependencies {
  repository: RoomRepository;
  users: RoomUserDirectory;
  clock: Clock;
  invitationGenerator: InvitationCodeGenerator;
  joinRateLimiter: JoinRateLimiter;
}

function notFound(): ApplicationError {
  return new ApplicationError('NOT_FOUND', 'Resource not found');
}

function roomClosed(): ApplicationError {
  return new ApplicationError('ROOM_CLOSED', 'Room is closed');
}

function invalidInvitation(): ApplicationError {
  return new ApplicationError('INVITATION_INVALID', 'Invitation is invalid or expired');
}

function idempotencyKeyReused(): ApplicationError {
  return new ApplicationError(
    'IDEMPOTENCY_KEY_REUSED',
    'clientRequestId was reused with a different payload',
  );
}

function versionConflict(currentVersion: number): ApplicationError {
  return new ApplicationError('VERSION_CONFLICT', 'Room version has changed', {
    currentVersion,
  });
}

function invalidStateTransition(): ApplicationError {
  return new ApplicationError(
    'INVALID_STATE_TRANSITION',
    'Room action is not allowed in the current state',
  );
}

function toObjectId(value: string): ObjectId | null {
  if (!ObjectId.isValid(value)) {
    return null;
  }
  const objectId = new ObjectId(value);
  return objectId.toHexString() === value.toLowerCase() ? objectId : null;
}

function actorId(actor: PublicUser): ObjectId {
  const id = toObjectId(actor.id);
  if (id === null) {
    throw new ApplicationError('UNAUTHENTICATED', 'Authentication required');
  }
  return id;
}

function publicRoomId(roomId: ObjectId): RoomId {
  return RoomIdSchema.parse(roomId.toHexString());
}

function publicRecipientIds(room: RoomDocument): UserId[] {
  return room.members.map((member) => UserIdSchema.parse(member.userId.toHexString()));
}

function secretReplay(roomId: ObjectId): SecretReplayResponse {
  return SecretReplayResponseSchema.parse({
    outcome: 'replayed',
    roomId: publicRoomId(roomId),
    invitation: null,
    recovery: 'rotate_with_new_client_request_id_if_needed',
  });
}

export class RoomService {
  private readonly repository: RoomRepository;
  private readonly users: RoomUserDirectory;
  private readonly clock: Clock;
  private readonly invitationGenerator: InvitationCodeGenerator;
  private readonly joinRateLimiter: JoinRateLimiter;

  constructor(dependencies: RoomServiceDependencies) {
    this.repository = dependencies.repository;
    this.users = dependencies.users;
    this.clock = dependencies.clock;
    this.invitationGenerator = dependencies.invitationGenerator;
    this.joinRateLimiter = dependencies.joinRateLimiter;
  }

  consumeJoinIpRateLimit(ipAddress: string): void {
    this.joinRateLimiter.consumeIp(ipAddress);
  }

  async createRoom(
    actor: PublicUser,
    input: ClientRequest,
  ): Promise<RoomActionResult<CreateRoomResponse>> {
    const actorUserId = actorId(actor);
    const clientRequestId = normalizeClientRequestId(input.clientRequestId);
    const payloadHash = createRoomPayloadHash(clientRequestId);
    const replay = await this.readSecretReplay({
      actorUserId,
      operation: CREATE_OPERATION,
      aggregateId: CREATE_AGGREGATE_ID,
      clientRequestId,
      payloadHash,
    });
    if (replay !== null) {
      return { data: replay, publication: null };
    }

    const roomId = new ObjectId();
    const lookupKey = roomReceiptLookupKey(
      actorUserId,
      CREATE_OPERATION,
      CREATE_AGGREGATE_ID,
      clientRequestId,
    );

    for (let attempt = 0; attempt < INVITATION_GENERATION_ATTEMPTS; attempt += 1) {
      const code = this.invitationGenerator();
      const canonicalCode = canonicalizeInvitationCode(code);
      const now = this.now();
      const room = RoomDocumentSchema.parse({
        _id: roomId,
        schemaVersion: ROOM_SCHEMA_VERSION,
        status: 'waiting',
        version: 1,
        hostUserId: actorUserId,
        members: [{ userId: actorUserId, role: 'host', joinedAt: now }],
        maxPlayers: ROOM_MAX_PLAYERS,
        invitation: {
          codeHash: hashInvitationCode(canonicalCode),
          createdAt: now,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        },
        activeSessionId: null,
        actionReceipts: [
          {
            actorUserId,
            operation: CREATE_OPERATION,
            aggregateId: CREATE_AGGREGATE_ID,
            clientRequestId,
            payloadHash,
            lookupKey,
            result: { roomId, roomVersion: 1, eventId: null, closed: null },
            createdAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + LOBBY_TTL_MS),
        deleteAfter: new Date(now.getTime() + LOBBY_TTL_MS),
      });

      try {
        await this.repository.insert(room);
      } catch (error) {
        if (error instanceof DuplicateInvitationCodeError) {
          continue;
        }
        if (error instanceof DuplicateRoomReceiptError) {
          const concurrentReplay = await this.readSecretReplay({
            actorUserId,
            operation: CREATE_OPERATION,
            aggregateId: CREATE_AGGREGATE_ID,
            clientRequestId,
            payloadHash,
          });
          if (concurrentReplay !== null) {
            return { data: concurrentReplay, publication: null };
          }
        }
        throw error;
      }

      const snapshot = await this.projectSnapshot(room);
      return {
        data: CreateRoomResponseSchema.parse({
          outcome: 'created',
          ...snapshot,
          invitation: { code, expiresAt: room.invitation.expiresAt.toISOString() },
        }),
        publication: null,
      };
    }

    throw new Error('Invitation code generation exhausted collision retries');
  }

  async getRoom(actor: PublicUser, roomIdInput: RoomId): Promise<RoomSnapshot> {
    const room = await this.requireVisibleRoom(actorId(actor), roomIdInput);
    this.assertRoomReadable(room, this.now());
    return this.projectSnapshot(room);
  }

  async joinRoom(
    actor: PublicUser,
    input: JoinRoomRequest,
  ): Promise<RoomActionResult<RoomSnapshot>> {
    const actorUserId = actorId(actor);
    const clientRequestId = normalizeClientRequestId(input.clientRequestId);
    const canonicalCode = canonicalizeInvitationCode(input.code);
    const payloadHash = joinRoomPayloadHash(clientRequestId, canonicalCode);
    this.joinRateLimiter.consumeUser(actorUserId.toHexString());

    const previous = await this.readJoinReplay(actorUserId, clientRequestId, payloadHash);
    if (previous !== null) {
      return previous;
    }

    const codeHash = hashInvitationCode(canonicalCode);
    const invitedRoom = await this.repository.findByInvitationCodeHash(codeHash);
    if (invitedRoom === null) {
      throw invalidInvitation();
    }

    const mutation: JoinMutationInput = {
      roomId: invitedRoom._id,
      actorUserId,
      clientRequestId,
      payloadHash,
      lookupKey: roomReceiptLookupKey(
        actorId(actor),
        JOIN_OPERATION,
        invitedRoom._id.toHexString(),
        clientRequestId,
      ),
      eventId: new ObjectId().toHexString(),
      codeHash,
      now: this.now(),
    };

    try {
      const noOpRoom = await this.repository.appendNoopJoinReceipt(mutation);
      if (noOpRoom !== null) {
        return { data: await this.projectSnapshot(noOpRoom), publication: null };
      }

      const joinedRoom = await this.repository.appendNewJoin(mutation);
      if (joinedRoom !== null) {
        return this.newJoinResult(joinedRoom, actorUserId, mutation.lookupKey);
      }
    } catch (error) {
      if (!(error instanceof DuplicateRoomReceiptError)) {
        throw error;
      }
      const replay = await this.readJoinReplay(actorUserId, clientRequestId, payloadHash);
      if (replay !== null) {
        return replay;
      }
      throw error;
    }

    return this.classifyFailedJoin(actorUserId, mutation);
  }

  async rotateInvitation(
    actor: PublicUser,
    roomIdInput: RoomId,
    input: RotateInvitationRequest,
  ): Promise<RoomActionResult<RotateInvitationResponse>> {
    const actorUserId = actorId(actor);
    const roomId = this.requireObjectRoomId(roomIdInput);
    const clientRequestId = normalizeClientRequestId(input.clientRequestId);
    const payloadHash = versionedRoomPayloadHash(
      ROTATE_OPERATION,
      roomId,
      clientRequestId,
      input.expectedVersion,
    );
    const replay = await this.readSecretReplay({
      actorUserId,
      operation: ROTATE_OPERATION,
      aggregateId: roomId.toHexString(),
      clientRequestId,
      payloadHash,
    });
    if (replay !== null) {
      return { data: replay, publication: null };
    }

    let initialRoom: RoomDocument;
    try {
      initialRoom = await this.requireVisibleRoom(actorUserId, roomIdInput);
      this.assertRotateAllowed(initialRoom, actorUserId, input.expectedVersion, this.now());
    } catch (error) {
      if (!(error instanceof ApplicationError)) {
        throw error;
      }
      // A concurrent identical request may have committed the rotation between the
      // receipt prelookup and this room read. The exact receipt then wins over the
      // stale precheck; real foreign or stale requests still get the original error.
      const racedReplay = await this.readSecretReplay({
        actorUserId,
        operation: ROTATE_OPERATION,
        aggregateId: roomId.toHexString(),
        clientRequestId,
        payloadHash,
      });
      if (racedReplay === null) {
        throw error;
      }
      return { data: racedReplay, publication: null };
    }
    const lookupKey = roomReceiptLookupKey(
      actorUserId,
      ROTATE_OPERATION,
      roomId.toHexString(),
      clientRequestId,
    );
    const eventId = new ObjectId().toHexString();

    for (let attempt = 0; attempt < INVITATION_GENERATION_ATTEMPTS; attempt += 1) {
      const code = this.invitationGenerator();
      const canonicalCode = canonicalizeInvitationCode(code);
      const now = this.now();
      try {
        const updated = await this.repository.rotateInvitation({
          roomId,
          actorUserId,
          clientRequestId,
          payloadHash,
          lookupKey,
          eventId,
          expectedVersion: input.expectedVersion,
          invitation: {
            codeHash: hashInvitationCode(canonicalCode),
            createdAt: now,
            expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
          },
          now,
        });
        if (updated !== null) {
          return this.rotatedResult(updated, code, lookupKey);
        }
      } catch (error) {
        if (error instanceof DuplicateInvitationCodeError) {
          continue;
        }
        if (!(error instanceof DuplicateRoomReceiptError)) {
          throw error;
        }
      }

      const concurrentReplay = await this.readSecretReplay({
        actorUserId,
        operation: ROTATE_OPERATION,
        aggregateId: roomId.toHexString(),
        clientRequestId,
        payloadHash,
      });
      if (concurrentReplay !== null) {
        return { data: concurrentReplay, publication: null };
      }
      const currentRoom = await this.requireVisibleRoom(actorUserId, roomIdInput);
      this.assertRotateAllowed(currentRoom, actorUserId, input.expectedVersion, this.now());
      throw new ApplicationError('OPERATION_IN_PROGRESS', 'Another room operation is in progress');
    }

    throw new Error('Invitation code generation exhausted collision retries');
  }

  async leaveRoom(
    actor: PublicUser,
    input: RoomLeaveRequest,
  ): Promise<RoomActionResult<RoomLeaveAckData>> {
    const actorUserId = actorId(actor);
    const roomId = this.requireObjectRoomId(input.roomId);
    const clientRequestId = normalizeClientRequestId(input.clientRequestId);
    const payloadHash = versionedRoomPayloadHash(
      LEAVE_OPERATION,
      roomId,
      clientRequestId,
      input.expectedVersion,
    );
    const replay = await this.readLeaveReplay(actorUserId, roomId, clientRequestId, payloadHash);
    if (replay !== null) {
      return { data: replay, publication: null };
    }

    let initialRoom: RoomDocument;
    try {
      initialRoom = await this.requireVisibleRoom(actorUserId, input.roomId);
      this.assertLeaveAllowed(initialRoom, actorUserId, input.expectedVersion, this.now());
    } catch (error) {
      if (!(error instanceof ApplicationError)) {
        throw error;
      }
      // The winning leave may already have removed the actor or closed the room.
      // Only an exact actor/room/request/payload receipt turns that into a replay.
      const racedReplay = await this.readLeaveReplay(
        actorUserId,
        roomId,
        clientRequestId,
        payloadHash,
      );
      if (racedReplay === null) {
        throw error;
      }
      return { data: racedReplay, publication: null };
    }
    const closeLobby = initialRoom.hostUserId.equals(actorUserId);
    const lookupKey = roomReceiptLookupKey(
      actorUserId,
      LEAVE_OPERATION,
      roomId.toHexString(),
      clientRequestId,
    );

    let updated: RoomDocument | null;
    try {
      updated = await this.repository.leaveLobby({
        roomId,
        actorUserId,
        clientRequestId,
        payloadHash,
        lookupKey,
        eventId: new ObjectId().toHexString(),
        expectedVersion: input.expectedVersion,
        closeLobby,
        now: this.now(),
      });
    } catch (error) {
      if (!(error instanceof DuplicateRoomReceiptError)) {
        throw error;
      }
      updated = null;
    }

    if (updated === null) {
      const concurrentReplay = await this.readLeaveReplay(
        actorUserId,
        roomId,
        clientRequestId,
        payloadHash,
      );
      if (concurrentReplay !== null) {
        return { data: concurrentReplay, publication: null };
      }
      const currentRoom = await this.requireVisibleRoom(actorUserId, input.roomId);
      this.assertLeaveAllowed(currentRoom, actorUserId, input.expectedVersion, this.now());
      throw new ApplicationError('OPERATION_IN_PROGRESS', 'Another room operation is in progress');
    }

    const receipt = MongoRoomRepository.receiptByLookupKey(updated, lookupKey);
    if (receipt.result.closed === null || receipt.result.eventId === null) {
      throw new Error('Committed leave receipt is incomplete');
    }
    const commonEvent = {
      eventId: receipt.result.eventId,
      roomId: publicRoomId(updated._id),
      version: updated.version,
      occurredAt: updated.updatedAt.toISOString(),
    };
    const event = closeLobby
      ? RoomClosedEventSchema.parse({
          ...commonEvent,
          type: 'room.closed',
          payload: { reason: 'host_left' },
        })
      : RoomMemberLeftEventSchema.parse({
          ...commonEvent,
          type: 'room.member_left',
          payload: { userId: actor.id, status: updated.status },
        });
    if (!closeLobby && event.type !== 'room.member_left') {
      throw new Error('Unexpected leave event projection');
    }
    return {
      data: {
        roomId: publicRoomId(updated._id),
        roomVersion: updated.version,
        closed: closeLobby,
      },
      publication: { recipientUserIds: publicRecipientIds(updated), event },
    };
  }

  private async newJoinResult(
    room: RoomDocument,
    actorUserId: ObjectId,
    lookupKey: string,
  ): Promise<RoomActionResult<RoomSnapshot>> {
    const snapshot = await this.projectSnapshot(room);
    const member = snapshot.room.members.find(
      (candidate) => candidate.user.id === actorUserId.toHexString(),
    );
    const receipt = MongoRoomRepository.receiptByLookupKey(room, lookupKey);
    if (member === undefined || receipt.result.eventId === null) {
      throw new Error('Committed join projection is incomplete');
    }
    const event = RoomMemberJoinedEventSchema.parse({
      eventId: receipt.result.eventId,
      roomId: snapshot.room.id,
      version: room.version,
      type: 'room.member_joined',
      occurredAt: room.updatedAt.toISOString(),
      payload: { member },
    });
    return {
      data: snapshot,
      publication: {
        recipientUserIds: snapshot.room.members.map((candidate) => candidate.user.id),
        event,
      },
    };
  }

  private async rotatedResult(
    room: RoomDocument,
    code: string,
    lookupKey: string,
  ): Promise<RoomActionResult<RotateInvitationResponse>> {
    const snapshot = await this.projectSnapshot(room);
    const receipt = MongoRoomRepository.receiptByLookupKey(room, lookupKey);
    if (receipt.result.eventId === null) {
      throw new Error('Committed rotation receipt omitted its event ID');
    }
    const expiresAt = room.invitation.expiresAt.toISOString();
    const event = RoomInvitationRotatedEventSchema.parse({
      eventId: receipt.result.eventId,
      roomId: snapshot.room.id,
      version: room.version,
      type: 'room.invitation_rotated',
      occurredAt: room.updatedAt.toISOString(),
      payload: { expiresAt },
    });
    return {
      data: RotateInvitationResponseSchema.parse({
        outcome: 'rotated',
        room: snapshot.room,
        invitation: { code, expiresAt },
      }),
      publication: {
        recipientUserIds: snapshot.room.members.map((member) => member.user.id),
        event,
      },
    };
  }

  private async classifyFailedJoin(
    actorUserId: ObjectId,
    mutation: JoinMutationInput,
  ): Promise<RoomActionResult<RoomSnapshot>> {
    const replay = await this.readJoinReplay(
      actorUserId,
      mutation.clientRequestId,
      mutation.payloadHash,
    );
    if (replay !== null) {
      return replay;
    }
    const room = await this.repository.findByInvitationCodeHash(mutation.codeHash);
    if (room === null) {
      throw invalidInvitation();
    }
    const now = this.now();
    const isMember = room.members.some((member) => member.userId.equals(actorUserId));

    if (!isMember) {
      if (
        room.invitation.expiresAt.getTime() <= now.getTime() ||
        room.expiresAt.getTime() <= now.getTime()
      ) {
        throw invalidInvitation();
      }
      this.assertJoinableStatus(room);
      if (room.members.length >= ROOM_MAX_PLAYERS) {
        throw new ApplicationError('ROOM_FULL', 'Room is full');
      }
    } else {
      if (room.status === 'closed' || room.expiresAt.getTime() <= now.getTime()) {
        throw roomClosed();
      }
      this.assertJoinableStatus(room);
      try {
        const noOpRoom = await this.repository.appendNoopJoinReceipt({
          ...mutation,
          now,
        });
        if (noOpRoom !== null) {
          return { data: await this.projectSnapshot(noOpRoom), publication: null };
        }
      } catch (error) {
        if (!(error instanceof DuplicateRoomReceiptError)) {
          throw error;
        }
      }
      const concurrentReplay = await this.readJoinReplay(
        actorUserId,
        mutation.clientRequestId,
        mutation.payloadHash,
      );
      if (concurrentReplay !== null) {
        return concurrentReplay;
      }
      const current = await this.repository.findById(room._id);
      if (
        current === null ||
        !current.members.some((member) => member.userId.equals(actorUserId))
      ) {
        throw notFound();
      }
    }

    throw new ApplicationError('OPERATION_IN_PROGRESS', 'Another room operation is in progress');
  }

  private assertJoinableStatus(room: RoomDocument): void {
    if (room.status === 'closed') {
      throw roomClosed();
    }
    if (room.status !== 'waiting' && room.status !== 'ready') {
      throw new ApplicationError('ROOM_NOT_JOINABLE', 'Room is not accepting new members');
    }
  }

  private assertRoomReadable(room: RoomDocument, now: Date): void {
    if (room.status === 'closed' || room.expiresAt.getTime() <= now.getTime()) {
      throw roomClosed();
    }
  }

  private assertRotateAllowed(
    room: RoomDocument,
    actorUserId: ObjectId,
    expectedVersion: number,
    now: Date,
  ): void {
    if (!room.hostUserId.equals(actorUserId)) {
      throw new ApplicationError('FORBIDDEN', 'Host permission required');
    }
    if (room.version !== expectedVersion) {
      throw versionConflict(room.version);
    }
    if (room.status === 'closed' || room.expiresAt.getTime() <= now.getTime()) {
      throw roomClosed();
    }
    if (room.status !== 'waiting' && room.status !== 'ready') {
      throw invalidStateTransition();
    }
  }

  private assertLeaveAllowed(
    room: RoomDocument,
    actorUserId: ObjectId,
    expectedVersion: number,
    now: Date,
  ): void {
    if (!room.members.some((member) => member.userId.equals(actorUserId))) {
      throw notFound();
    }
    if (room.version !== expectedVersion) {
      throw versionConflict(room.version);
    }
    if (room.status === 'closed' || room.expiresAt.getTime() <= now.getTime()) {
      throw roomClosed();
    }
    if (room.status !== 'waiting' && room.status !== 'ready') {
      throw invalidStateTransition();
    }
  }

  private async readSecretReplay(search: {
    actorUserId: ObjectId;
    operation: 'create' | 'rotate';
    aggregateId: string;
    clientRequestId: string;
    payloadHash: string;
  }): Promise<SecretReplayResponse | null> {
    const match = await this.repository.findReceipt(search);
    if (match === null) {
      return null;
    }
    this.assertReceiptPayload(match, search.payloadHash);
    return secretReplay(match.receipt.result.roomId);
  }

  private async readLeaveReplay(
    actorUserId: ObjectId,
    roomId: ObjectId,
    clientRequestId: string,
    payloadHash: string,
  ): Promise<RoomLeaveAckData | null> {
    const match = await this.repository.findReceipt({
      actorUserId,
      operation: LEAVE_OPERATION,
      aggregateId: roomId.toHexString(),
      clientRequestId,
    });
    if (match === null) {
      return null;
    }
    this.assertReceiptPayload(match, payloadHash);
    if (match.receipt.result.closed === null) {
      throw new Error('Leave receipt omitted its close result');
    }
    return {
      roomId: publicRoomId(match.receipt.result.roomId),
      roomVersion: match.receipt.result.roomVersion,
      closed: match.receipt.result.closed,
    };
  }

  private async readJoinReplay(
    actorUserId: ObjectId,
    clientRequestId: string,
    payloadHash: string,
  ): Promise<RoomActionResult<RoomSnapshot> | null> {
    const match = await this.repository.findReceipt({
      actorUserId,
      operation: JOIN_OPERATION,
      clientRequestId,
    });
    if (match === null) {
      return null;
    }
    this.assertReceiptPayload(match, payloadHash);
    if (!match.room.members.some((member) => member.userId.equals(actorUserId))) {
      throw notFound();
    }
    this.assertRoomReadable(match.room, this.now());
    return { data: await this.projectSnapshot(match.room), publication: null };
  }

  private assertReceiptPayload(match: ReceiptMatch, payloadHash: string): void {
    if (match.receipt.payloadHash !== payloadHash) {
      throw idempotencyKeyReused();
    }
  }

  private requireObjectRoomId(roomId: RoomId): ObjectId {
    const id = toObjectId(roomId);
    if (id === null) {
      throw notFound();
    }
    return id;
  }

  private async requireVisibleRoom(
    actorUserId: ObjectId,
    roomIdInput: RoomId,
  ): Promise<RoomDocument> {
    const roomId = this.requireObjectRoomId(roomIdInput);
    const room = await this.repository.findVisibleById(roomId, actorUserId);
    if (room === null) {
      throw notFound();
    }
    return room;
  }

  private async projectSnapshot(room: RoomDocument): Promise<RoomSnapshot> {
    const users = await this.users.findPublicUsers(room.members.map((member) => member.userId));
    const members = room.members.map((member) => {
      const user = users.get(member.userId.toHexString());
      if (user === undefined) {
        throw new Error('Room projection could not resolve a current member');
      }
      return { user, role: member.role, joinedAt: member.joinedAt.toISOString() };
    });
    const host = users.get(room.hostUserId.toHexString());
    if (host === undefined) {
      throw new Error('Room projection could not resolve the host');
    }
    return RoomSnapshotSchema.parse({
      room: {
        id: publicRoomId(room._id),
        status: room.status,
        version: room.version,
        host,
        members,
        maxPlayers: ROOM_MAX_PLAYERS,
        activeSessionId: room.activeSessionId?.toHexString() ?? null,
        createdAt: room.createdAt.toISOString(),
        expiresAt: room.expiresAt.toISOString(),
      },
      recentMessages: [],
      presence: [],
    });
  }

  private now(): Date {
    return new Date(this.clock().getTime());
  }
}

interface CreateRoomServiceOptions {
  database: Db;
  clock?: Clock;
  invitationGenerator?: InvitationCodeGenerator;
  joinRateLimiter?: JoinRateLimiter;
  repository?: RoomRepository;
}

export async function createRoomService(options: CreateRoomServiceOptions): Promise<RoomService> {
  const clock = options.clock ?? systemClock;
  await ensureRoomIndexes(options.database);
  return new RoomService({
    repository: options.repository ?? new MongoRoomRepository(options.database),
    users: new MongoRoomUserDirectory(options.database),
    clock,
    invitationGenerator: options.invitationGenerator ?? generateInvitationCode,
    joinRateLimiter: options.joinRateLimiter ?? new JoinRateLimiter(clock),
  });
}
