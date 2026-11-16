import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  startMongoTestDatabase,
  type MongoTestDatabase,
} from '../../../backend/test/support/mongo-test-database.js';
import { artifactPath } from './runtime';

const TEST_SESSION_SECRET = 't010-only-local-browser-test-session-secret-not-for-production';

function backendOrigin(): string {
  const origin = process.env['T010_BACKEND_ORIGIN'];
  if (origin === undefined || new URL(origin).hostname !== '127.0.0.1') {
    throw new Error('T010_BACKEND_ORIGIN must be configured by the fullstack Playwright config');
  }
  return origin;
}

function frontendOrigin(): string {
  const origin = process.env['T010_FRONTEND_ORIGIN'];
  if (origin === undefined || new URL(origin).hostname !== '127.0.0.1') {
    throw new Error('T010_FRONTEND_ORIGIN must be configured by the fullstack Playwright config');
  }
  return origin;
}

async function stopOwnedBackend(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function waitForBackend(child: ChildProcess, origin: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`QA backend exited before readiness: ${child.exitCode ?? child.signalCode}`);
    }
    try {
      const response = await fetch(`${origin}/api/v1/ready`);
      if (response.ok && child.exitCode === null && child.signalCode === null) return;
      lastError = new Error(`Readiness returned ${response.status}`);
    } catch (error: unknown) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for the isolated QA backend', { cause: lastError });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  let mongo: MongoTestDatabase | undefined;
  let backend: ChildProcess | undefined;
  let logStream: WriteStream | undefined;
  const origin = backendOrigin();
  const appOrigin = frontendOrigin();

  try {
    await mkdir(artifactPath(''), { recursive: true });
    mongo = await startMongoTestDatabase();
    const mongoUri = mongo.mongod.getUri('casetogether_t010_fullstack');
    const databaseName = 'casetogether_t010_fullstack';
    const backendLogPath = artifactPath('backend.log');
    const providerEvidencePath = artifactPath('provider-evidence.json');
    logStream = createWriteStream(backendLogPath, { encoding: 'utf8' });
    const backendDirectory = fileURLToPath(new URL('../../../backend/', import.meta.url));
    const inheritedEnvironment = Object.fromEntries(
      ['PATH', 'HOME', 'LANG', 'LC_ALL'].flatMap((key) => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value]];
      }),
    );
    backend = spawn(
      'pnpm',
      ['exec', 'tsx', '--conditions=development', 'test/qa/provider-null-main.mjs'],
      {
        cwd: backendDirectory,
        env: {
          ...inheritedEnvironment,
          NODE_ENV: 'test',
          PORT: String(new URL(origin).port),
          MONGODB_URI: mongoUri,
          SESSION_SECRET: TEST_SESSION_SECRET,
          FRONTEND_ORIGIN: appOrigin,
          T010_PROVIDER_EVIDENCE_FILE: providerEvidencePath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    backend.stdout?.on('data', (chunk: Uint8Array) => logStream?.write(chunk.toString()));
    backend.stderr?.on('data', (chunk: Uint8Array) => logStream?.write(chunk.toString()));
    const ownedBackend = backend;
    await waitForBackend(ownedBackend, origin);
    await writeFile(
      artifactPath('runtime.json'),
      `${JSON.stringify(
        {
          backendOrigin: origin,
          frontendOrigin: appOrigin,
          mongoUri,
          databaseName,
          providerEvidencePath,
          backendLogPath,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch (error) {
    if (backend !== undefined) await stopOwnedBackend(backend);
    if (logStream !== undefined) logStream.end();
    await mongo?.close();
    throw error;
  }

  const ownedBackend = backend;
  const ownedMongo = mongo;
  const ownedLogStream = logStream;
  return async () => {
    if (ownedBackend !== undefined) await stopOwnedBackend(ownedBackend);
    ownedLogStream?.end();
    await ownedMongo?.close();
  };
}
