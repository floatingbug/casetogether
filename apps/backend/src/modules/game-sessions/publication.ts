import {
  GameEventSchema,
  RoomIdSchema,
  RoomStartedEventSchema,
  UserIdSchema,
  type GameEvent,
  type RoomId,
  type RoomStartedEvent,
  type UserId,
} from '@casetogether/shared';
import { z } from 'zod';
import type { RecipientGameEvent } from '../../game-engine/types.js';

export interface ProjectedGameDelivery {
  readonly recipientUserId: UserId;
  readonly event: GameEvent;
}

export type GamePublication =
  | {
      readonly kind: 'start';
      readonly roomId: RoomId;
      readonly roomEvent: RoomStartedEvent;
      readonly deliveries: readonly ProjectedGameDelivery[];
    }
  | {
      readonly kind: 'events';
      readonly roomId: RoomId;
      readonly deliveries: readonly ProjectedGameDelivery[];
    };

export interface GamePublicationPort {
  publish(publication: GamePublication): Promise<void>;
}

export interface GameActionResult<Data> {
  readonly data: Data;
  readonly publication: GamePublication | null;
}

const deliverySchema = z.object({ recipientUserId: UserIdSchema, event: GameEventSchema }).strict();

const startPublicationSchema = z
  .object({
    kind: z.literal('start'),
    roomId: RoomIdSchema,
    roomEvent: RoomStartedEventSchema,
    deliveries: z.array(deliverySchema).min(1).max(4),
  })
  .strict();

const eventsPublicationSchema = z
  .object({
    kind: z.literal('events'),
    roomId: RoomIdSchema,
    deliveries: z.array(deliverySchema).min(1).max(4),
  })
  .strict();

const GamePublicationSchema = z.discriminatedUnion('kind', [
  startPublicationSchema,
  eventsPublicationSchema,
]);

export function parseGamePublication(publication: GamePublication): GamePublication {
  return GamePublicationSchema.parse(publication);
}

export function projectDeliveries(
  recipientEvents: readonly RecipientGameEvent[],
): ProjectedGameDelivery[] {
  return recipientEvents.flatMap(({ recipientUserId, event }) =>
    event === null ? [] : [{ recipientUserId, event: GameEventSchema.parse(event) }],
  );
}

export class NoopGamePublicationPort implements GamePublicationPort {
  publish(_publication: GamePublication): Promise<void> {
    return Promise.resolve();
  }
}
