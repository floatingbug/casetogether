import { ObjectId, type Db } from 'mongodb';
import { ensureCaseIndexes } from '../../database/case-indexes.js';
import { STILLER_GLOCKENSCHLAG_CASE } from '../../game-engine/index.js';
import { CaseDefinitionDocumentSchema } from './persistence.js';

/** Provisions the immutable curated MVP case without overwriting an existing case version. */
export async function provisionDefaultCases(database: Db, now = new Date()): Promise<void> {
  await ensureCaseIndexes(database);
  const curatedCase = STILLER_GLOCKENSCHLAG_CASE;
  const document = CaseDefinitionDocumentSchema.parse({
    ...curatedCase,
    _id: new ObjectId(),
    slug: curatedCase.id,
    createdAt: now,
    updatedAt: now,
  });
  await database
    .collection('cases')
    .updateOne(
      { slug: curatedCase.id, version: curatedCase.version },
      { $setOnInsert: document },
      { upsert: true },
    );
}
