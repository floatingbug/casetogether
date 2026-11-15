import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSetCookie } from 'cookie';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server-core';

const testSecret = 'T003-built-main-smoke-secret-not-for-production';
const password = '  synthetic-main-smoke-password  ';
const origin = 'http://localhost:5173';
const backendDirectory = fileURLToPath(new URL('../..', import.meta.url));
const temporaryRoot = await mkdtemp('/tmp/opencode/casetogether-t003-main-smoke-');
const dbPath = join(temporaryRoot, 'db');
await mkdir(dbPath);
let mongod;
let probeClient;
let backend;
let startupTimer;
let port;
let exitCode = null;

async function reserveFreePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (address === null || typeof address === 'string') {
    throw new Error('No TCP port was assigned');
  }
  await new Promise((resolve, reject) => {
    reservation.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function request(path, options = {}) {
  return fetch(`http://127.0.0.1:${port}/api/v1${path}`, options);
}

try {
  mongod = await MongoMemoryServer.create({
    binary: {
      version: '7.0.24',
      downloadDir: '/tmp/opencode/casetogether-mongodb-binaries',
    },
    instance: { dbPath, ip: '127.0.0.1', launchTimeout: 60_000 },
  });
  const uri = mongod.getUri('casetogether_main_smoke');
  probeClient = await MongoClient.connect(uri);
  const database = probeClient.db('casetogether_main_smoke');
  const buildInfo = await database.command({ buildInfo: 1 });
  port = await reserveFreePort();
  backend = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: backendDirectory,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: String(port),
      MONGODB_URI: uri,
      SESSION_SECRET: testSecret,
      FRONTEND_ORIGIN: origin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let backendOutput = '';
  backend.stdout.on('data', (chunk) => {
    backendOutput += chunk.toString();
  });
  backend.stderr.on('data', () => {});
  const earlyExit = once(backend, 'exit').then(([code]) => {
    exitCode = code;
    throw new Error(`Built backend exited before readiness (${code})`);
  });
  const listening = new Promise((resolve) => {
    backend.stdout.on('data', () => {
      if (backendOutput.includes('backend_listening')) {
        resolve();
      }
    });
  });
  startupTimer = setTimeout(() => backend.kill('SIGTERM'), 20_000);
  await Promise.race([listening, earlyExit]);

  const health = await request('/health');
  const ready = await request('/ready');
  const registration = await request('/auth/register', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'MAIN-SMOKE@Example.test',
      password,
      displayName: ' Hauptsmoke ',
    }),
  });
  const serializedCookie = registration.headers.get('set-cookie');
  if (serializedCookie === null) {
    throw new Error('Built main did not issue a session cookie');
  }
  const cookie = parseSetCookie(serializedCookie);
  const cookieHeader = `ct_session=${cookie.value ?? ''}`;
  await registration.arrayBuffer();

  const me = await request('/me', { headers: { Cookie: cookieHeader } });
  const meBody = await me.json();
  if (meBody?.data?.displayName !== 'Hauptsmoke' || meBody?.data?.emailNormalized !== undefined) {
    throw new Error('Built main returned an invalid PublicUser projection');
  }
  const logout = await request('/auth/logout', {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookieHeader },
  });
  await logout.arrayBuffer();
  const afterLogout = await request('/me', { headers: { Cookie: cookieHeader } });
  await afterLogout.arrayBuffer();

  const statuses = {
    health: health.status,
    ready: ready.status,
    register: registration.status,
    me: me.status,
    logout: logout.status,
    afterLogout: afterLogout.status,
  };
  const expected = {
    health: 200,
    ready: 200,
    register: 201,
    me: 200,
    logout: 204,
    afterLogout: 401,
  };
  if (JSON.stringify(statuses) !== JSON.stringify(expected)) {
    throw new Error('Built-main status mismatch');
  }
  const persistedUser = await database
    .collection('users')
    .findOne({ emailNormalized: 'main-smoke@example.test' });
  if (persistedUser === null) {
    throw new Error('Built main did not persist the normalized email');
  }

  backend.kill('SIGTERM');
  const [code] = await once(backend, 'exit');
  exitCode = code;
  if (code !== 0) {
    throw new Error(`Built backend shutdown failed (${code})`);
  }
  console.log(
    JSON.stringify({
      event: 't003_built_main_smoke',
      statuses,
      mongodbVersion: buildInfo.version,
      normalizedEmailPersisted: persistedUser.emailNormalized === 'main-smoke@example.test',
      shutdownExitCode: code,
    }),
  );
} finally {
  if (startupTimer !== undefined) {
    clearTimeout(startupTimer);
  }
  if (backend !== undefined && exitCode === null) {
    backend.kill('SIGTERM');
    await Promise.race([
      once(backend, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (exitCode === null) {
      backend.kill('SIGKILL');
    }
  }
  await probeClient?.close();
  if (mongod !== undefined) {
    await mongod.stop({ doCleanup: true, force: true });
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
