import type { Db } from 'mongodb';

export async function ensureCaseIndexes(database: Db): Promise<void> {
  const cases = database.collection('cases');
  await cases.createIndex(
    { slug: 1, version: 1 },
    { unique: true, name: 'cases_slug_version_unique' },
  );
  await cases.createIndex({ status: 1, version: 1 }, { name: 'cases_status_version' });
}
