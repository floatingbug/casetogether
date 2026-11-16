import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSetCookie } from 'cookie';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server-core';

const testSecret = 'T005-built-rooms-smoke-secret-not-for-production';
const password = '  synthetic-rooms-smoke-password  ';
const origin = 'http://localhost:5173';
const backendDirectory = fileURLToPath(new URL('../..', import.meta.url));
const temporaryRoot = await mkdtemp('/tmp/opencode/casetogether-t005-rooms-smoke-');
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

async function launchBackend() {
  exitCode = null;
  backend = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: backendDirectory,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: String(port),
      MONGODB_URI: mongod.getUri('casetogether_rooms_smoke'),
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
  const timeout = new Promise((_, reject) => {
    startupTimer = setTimeout(() => {
      backend.kill('SIGTERM');
      reject(new Error('Built backend did not start within twenty seconds'));
    }, 20_000);
  });
  try {
    await Promise.race([listening, earlyExit, timeout]);
  } finally {
    if (startupTimer !== undefined) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
  }
}

async function stopBackend() {
  if (backend === undefined) {
    return;
  }
  backend.kill('SIGTERM');
  const [code] = await once(backend, 'exit');
  exitCode = code;
  backend = undefined;
  if (code !== 0) {
    throw new Error(`Built backend shutdown failed (${code})`);
  }
}

async function request(path, { method = 'GET', body, cookie } = {}) {
  return fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: {
      ...(method === 'POST' ? { Origin: origin } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function register(email, displayName) {
  const response = await request('/auth/register', {
    method: 'POST',
    body: { email, password, displayName },
  });
  if (response.status !== 201) {
    throw new Error(`Registration returned ${response.status}`);
  }
  await response.arrayBuffer();
  const serializedCookie = response.headers.get('set-cookie');
  if (serializedCookie === null) {
    throw new Error('Registration omitted its auth cookie');
  }
  const cookie = parseSetCookie(serializedCookie);
  return `ct_session=${cookie.value ?? ''}`;
}

async function readJson(response) {
  return { status: response.status, body: await response.json() };
}

try {
  mongod = await MongoMemoryServer.create({
    binary: {
      version: '7.0.24',
      downloadDir: '/tmp/opencode/casetogether-mongodb-binaries',
    },
    instance: { dbPath, ip: '127.0.0.1', launchTimeout: 60_000 },
  });
  const uri = mongod.getUri('casetogether_rooms_smoke');
  probeClient = await MongoClient.connect(uri);
  const database = probeClient.db('casetogether_rooms_smoke');
  const buildInfo = await database.command({ buildInfo: 1 });
  port = await reserveFreePort();
  await launchBackend();

  const hostCookie = await register('ROOM-HOST@Example.test', 'Room host');
  const guestCookie = await register('ROOM-GUEST@Example.test', 'Room guest');
  const createRequestId = randomUUID();
  const createdResponse = await request('/rooms', {
    method: 'POST',
    cookie: hostCookie,
    body: { clientRequestId: createRequestId },
  });
  const created = await readJson(createdResponse);
  if (created.status !== 201 || created.body?.data?.outcome !== 'created') {
    throw new Error('Built main did not create a room');
  }
  const roomId = created.body.data.room.id;
  const firstCode = created.body.data.invitation.code;

  const joined = await readJson(
    await request('/rooms/join', {
      method: 'POST',
      cookie: guestCookie,
      body: { clientRequestId: randomUUID(), code: firstCode },
    }),
  );
  if (joined.status !== 200 || joined.body?.data?.room?.version !== 2) {
    throw new Error('Built main did not join through the auth cookie');
  }
  const fetched = await readJson(await request(`/rooms/${roomId}`, { cookie: hostCookie }));
  if (fetched.status !== 200 || JSON.stringify(fetched.body).includes(firstCode)) {
    throw new Error('Built main exposed invitation material in a room snapshot');
  }

  const rotateRequestId = randomUUID();
  const rotated = await readJson(
    await request(`/rooms/${roomId}/invitation/rotate`, {
      method: 'POST',
      cookie: hostCookie,
      body: { clientRequestId: rotateRequestId, expectedVersion: 2 },
    }),
  );
  if (rotated.status !== 200 || rotated.body?.data?.outcome !== 'rotated') {
    throw new Error('Built main did not rotate as host');
  }
  const secondCode = rotated.body.data.invitation.code;
  const forbidden = await readJson(
    await request(`/rooms/${roomId}/invitation/rotate`, {
      method: 'POST',
      cookie: guestCookie,
      body: { clientRequestId: randomUUID(), expectedVersion: 3 },
    }),
  );
  if (forbidden.status !== 403 || forbidden.body?.error?.code !== 'FORBIDDEN') {
    throw new Error('Built main did not enforce host rotation authorization');
  }

  await stopBackend();
  await launchBackend();

  const createReplay = await readJson(
    await request('/rooms', {
      method: 'POST',
      cookie: hostCookie,
      body: { clientRequestId: createRequestId },
    }),
  );
  const rotateReplay = await readJson(
    await request(`/rooms/${roomId}/invitation/rotate`, {
      method: 'POST',
      cookie: hostCookie,
      body: { clientRequestId: rotateRequestId, expectedVersion: 2 },
    }),
  );
  for (const replay of [createReplay, rotateReplay]) {
    if (
      replay.status !== 200 ||
      replay.body?.data?.outcome !== 'replayed' ||
      replay.body?.data?.invitation !== null ||
      JSON.stringify(replay.body).includes(firstCode) ||
      JSON.stringify(replay.body).includes(secondCode)
    ) {
      throw new Error('Built-main restart replay exposed or regenerated a secret');
    }
  }

  const raw = await database.collection('rooms').findOne({ _id: new ObjectId(roomId) });
  const serializedRaw = JSON.stringify(raw);
  if (
    raw?.version !== 3 ||
    raw?.members?.length !== 2 ||
    serializedRaw.includes(firstCode) ||
    serializedRaw.includes(secondCode) ||
    typeof raw?.invitation?.codeHash !== 'string'
  ) {
    throw new Error('Built main persisted unexpected room or invitation material');
  }

  await stopBackend();
  console.log(
    JSON.stringify({
      event: 't005_built_rooms_main_smoke',
      statuses: {
        registerHost: 201,
        registerGuest: 201,
        create: created.status,
        join: joined.status,
        get: fetched.status,
        rotate: rotated.status,
        nonHostRotate: forbidden.status,
        createReplayAfterRestart: createReplay.status,
        rotateReplayAfterRestart: rotateReplay.status,
      },
      mongodbVersion: buildInfo.version,
      roomVersionAfterReplays: raw.version,
      membersAfterReplays: raw.members.length,
      shutdownExitCode: exitCode,
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
