import { createApp } from './app.js';
import { readBackendRuntimeConfig } from './config.js';
import { MongoDatabase } from './database/mongodb.js';
import {
  createGameSessionApplication,
  provisionDefaultCases,
} from './modules/game-sessions/index.js';
import type { GameSessionService } from './modules/game-sessions/game-session-service.js';
import type { StartIntentCleanup } from './modules/game-sessions/start-intent-cleanup.js';
import {
  createIdentityService,
  type IdentityService,
} from './modules/identity/identity-service.js';
import { createRoomService, type RoomService } from './modules/rooms/room-service.js';
import { createRealtimeGateway, type RealtimeGateway } from './realtime/gateway.js';

async function start(): Promise<void> {
  const config = readBackendRuntimeConfig();
  const mongoDatabase = new MongoDatabase(config.mongodbUri);
  await mongoDatabase.connect();

  let identityService: IdentityService;
  let roomService: RoomService;
  let gameSessionService: GameSessionService;
  let startIntentCleanup: StartIntentCleanup;
  let realtimeGateway: RealtimeGateway;
  try {
    identityService = await createIdentityService({
      database: mongoDatabase.database,
      sessionSecret: config.sessionSecret,
    });
    roomService = await createRoomService({ database: mongoDatabase.database });
    realtimeGateway = await createRealtimeGateway({
      database: mongoDatabase.database,
      identityService,
      roomService,
      cookieConfiguration: config.authCookie,
      allowedOrigins: config.allowedOrigins,
    });
    const gameApplication = await createGameSessionApplication({
      database: mongoDatabase.database,
      publicationPort: {
        publish: (publication) => realtimeGateway.publishGamePublication(publication),
      },
    });
    gameSessionService = gameApplication.gameSessions;
    startIntentCleanup = gameApplication.startIntentCleanup;
    await provisionDefaultCases(mongoDatabase.database);
    realtimeGateway.configureGameServices({
      gameSessions: gameApplication.gameSessions,
      dialogue: gameApplication.dialogue,
    });
  } catch (error) {
    await mongoDatabase.close();
    throw error;
  }

  const app = createApp({
    allowedOrigins: config.allowedOrigins,
    nodeEnv: config.nodeEnv,
    mongoDbStatus: () => mongoDatabase.ping(),
    identityService,
    roomService,
    gameSessionService,
    realtimeGateway,
  });
  const host = process.env['HOST'] ?? '127.0.0.1';
  const server = app.listen(config.port, host, () => {
    console.log(JSON.stringify({ event: 'backend_listening', port: config.port }));
  });
  realtimeGateway.attach(server);
  startIntentCleanup.start();
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    startIntentCleanup.stop();
    realtimeGateway.close();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    } catch {
      console.error(JSON.stringify({ event: 'backend_http_shutdown_failed' }));
      process.exitCode = 1;
    }

    try {
      await mongoDatabase.close();
    } catch {
      console.error(JSON.stringify({ event: 'backend_database_shutdown_failed' }));
      process.exitCode = 1;
    }
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

try {
  await start();
} catch {
  console.error(JSON.stringify({ event: 'backend_start_failed' }));
  process.exitCode = 1;
}
