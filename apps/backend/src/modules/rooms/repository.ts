import type { ObjectId } from 'mongodb';
import type {
  ActionReceiptDocument,
  InvitationDocument,
  RoomDocument,
  RoomOperation,
} from './persistence.js';

export interface ReceiptSearch {
  actorUserId: ObjectId;
  operation: RoomOperation;
  aggregateId?: string;
  clientRequestId: string;
}

export interface ReceiptMatch {
  room: RoomDocument;
  receipt: ActionReceiptDocument;
}

export interface ReceiptMutationInput {
  actorUserId: ObjectId;
  clientRequestId: string;
  payloadHash: string;
  lookupKey: string;
  eventId: string | null;
  now: Date;
}

export interface JoinMutationInput extends ReceiptMutationInput {
  roomId: ObjectId;
  codeHash: string;
}

export interface RotateMutationInput extends ReceiptMutationInput {
  roomId: ObjectId;
  expectedVersion: number;
  invitation: InvitationDocument;
}

export interface LeaveMutationInput extends ReceiptMutationInput {
  roomId: ObjectId;
  expectedVersion: number;
  closeLobby: boolean;
}

export interface RoomRepository {
  insert(room: RoomDocument): Promise<void>;
  findById(roomId: ObjectId): Promise<RoomDocument | null>;
  findVisibleById(roomId: ObjectId, actorUserId: ObjectId): Promise<RoomDocument | null>;
  findByInvitationCodeHash(codeHash: string): Promise<RoomDocument | null>;
  findReceipt(search: ReceiptSearch): Promise<ReceiptMatch | null>;
  appendNoopJoinReceipt(input: JoinMutationInput): Promise<RoomDocument | null>;
  appendNewJoin(input: JoinMutationInput): Promise<RoomDocument | null>;
  rotateInvitation(input: RotateMutationInput): Promise<RoomDocument | null>;
  leaveLobby(input: LeaveMutationInput): Promise<RoomDocument | null>;
}

export class DuplicateInvitationCodeError extends Error {
  constructor() {
    super('The invitation code hash already exists');
    this.name = 'DuplicateInvitationCodeError';
  }
}

export class DuplicateRoomReceiptError extends Error {
  constructor() {
    super('The room action receipt already exists');
    this.name = 'DuplicateRoomReceiptError';
  }
}
