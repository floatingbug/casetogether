import type { Db } from 'mongodb';
import type { DialogueExecutionCoordinator, DialogueProvider } from '../../ai/index.js';
import { ensureCaseIndexes } from '../../database/case-indexes.js';
import { ensureGameSessionIndexes } from '../../database/game-session-indexes.js';
import { systemClock, type Clock } from '../identity/clock.js';
import { MongoRoomUserDirectory } from '../rooms/user-directory.js';
import type { DialogueRateLimiter } from '../dialogue/rate-limiter.js';
import { DialogueService } from '../dialogue/dialogue-service.js';
import { GameSessionService } from './game-session-service.js';
import {
  MongoCaseRepository,
  MongoGameSessionRepository,
  MongoGameSessionRoomRepository,
} from './mongo-repositories.js';
import type { GamePublicationPort } from './publication.js';

export interface GameSessionApplicationOptions {
  database: Db;
  clock?: Clock;
  publicationPort?: GamePublicationPort;
  provider?: DialogueProvider | null;
  dialogueCoordinator?: DialogueExecutionCoordinator;
  dialogueRateLimiter?: DialogueRateLimiter;
}

export async function createGameSessionApplication(
  options: GameSessionApplicationOptions,
): Promise<{
  gameSessions: GameSessionService;
  dialogue: DialogueService;
}> {
  await ensureCaseIndexes(options.database);
  await ensureGameSessionIndexes(options.database);
  const clock = options.clock ?? systemClock;
  const sessions = new MongoGameSessionRepository(options.database);
  const rooms = new MongoGameSessionRoomRepository(options.database);
  const cases = new MongoCaseRepository(options.database);
  const users = new MongoRoomUserDirectory(options.database);
  const publicationDependencies =
    options.publicationPort === undefined ? {} : { publicationPort: options.publicationPort };
  const gameSessions = new GameSessionService({
    sessions,
    rooms,
    cases,
    users,
    clock,
    ...publicationDependencies,
  });
  const dialogue = new DialogueService({
    sessions,
    rooms,
    cases,
    provider: options.provider ?? null,
    clock,
    ...publicationDependencies,
    ...(options.dialogueCoordinator === undefined
      ? {}
      : { coordinator: options.dialogueCoordinator }),
    ...(options.dialogueRateLimiter === undefined
      ? {}
      : { rateLimiter: options.dialogueRateLimiter }),
  });
  return { gameSessions, dialogue };
}
