import { MongoClient, type Db } from 'mongodb';

export type MongoDbStatus = 'up' | 'down';

export class MongoDatabase {
  readonly client: MongoClient;
  readonly database: Db;

  constructor(uri: string, databaseName?: string) {
    this.client = new MongoClient(uri);
    this.database = databaseName === undefined ? this.client.db() : this.client.db(databaseName);
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async ping(): Promise<MongoDbStatus> {
    try {
      const result = await this.database.command({ ping: 1 });
      return result['ok'] === 1 ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
