import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server-core';

export const TEST_MONGODB_VERSION = '7.0.24';
export const TEST_MONGODB_BINARY_DIRECTORY = join(tmpdir(), 'casetogether-mongodb-binaries');
const TEST_TEMP_DIRECTORY = tmpdir();

export interface MongoTestDatabase {
  database: Db;
  client: MongoClient;
  mongod: MongoMemoryServer;
  binaryVersion: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

function buildVersion(buildInfo: unknown): string {
  if (typeof buildInfo !== 'object' || buildInfo === null) {
    throw new Error('MongoDB buildInfo did not contain a version');
  }
  const version = Reflect.get(buildInfo, 'version');
  if (typeof version !== 'string') {
    throw new Error('MongoDB buildInfo did not contain a version');
  }
  return version;
}

export async function startMongoTestDatabase(): Promise<MongoTestDatabase> {
  const temporaryRoot = await mkdtemp(join(TEST_TEMP_DIRECTORY, 'casetogether-t003-db-'));
  const databasePath = join(temporaryRoot, 'mongod-data');
  await mkdir(databasePath);
  let mongod: MongoMemoryServer | undefined;
  let client: MongoClient | undefined;

  try {
    mongod = await MongoMemoryServer.create({
      binary: {
        version: TEST_MONGODB_VERSION,
        downloadDir: TEST_MONGODB_BINARY_DIRECTORY,
      },
      instance: {
        dbPath: databasePath,
        ip: '127.0.0.1',
        launchTimeout: 60_000,
      },
    });
    client = new MongoClient(mongod.getUri('casetogether_t003_test'));
    await client.connect();
    const database = client.db('casetogether_t003_test');
    const binaryVersion = buildVersion(await database.command({ buildInfo: 1 }));
    let closed = false;

    return {
      database,
      client,
      mongod,
      binaryVersion,
      reset: async () => {
        await Promise.all([
          database.collection('users').deleteMany({}),
          database.collection('authSessions').deleteMany({}),
        ]);
      },
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        await client?.close();
        await mongod?.stop({ doCleanup: true, force: true });
        await rm(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await client?.close();
    await mongod?.stop({ doCleanup: true, force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
