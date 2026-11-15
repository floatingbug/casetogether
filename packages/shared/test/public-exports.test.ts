import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as shared from '../src/index.js';

const forbiddenExports = [
  'CaseTruth',
  'CaseTruthSchema',
  'SuspectSecret',
  'SuspectSecretSchema',
  'PrivateClueRule',
  'EngineState',
  'EngineStateSchema',
  'AuthSessionRecord',
  'ProviderConfig',
  'DialogueProvider',
  'AuthorizedDialogueContext',
  'AiProviderResult',
];

describe('public contract boundary', () => {
  it.each(forbiddenExports)('does not export server-only contract %s', (name) => {
    expect(Object.hasOwn(shared, name)).toBe(false);
  });

  it('contains no backend-secret identifiers in shared source files', () => {
    const sourceDirectory = fileURLToPath(new URL('../src', import.meta.url));
    const files = readdirSync(sourceDirectory)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => join(sourceDirectory, file));
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    const forbiddenIdentifiers = [
      'passwordHash',
      'sessionIdHash',
      'codeHash',
      'SESSION_SECRET',
      'OPENAI_API_KEY',
      'ProviderConfig',
      'AuthorizedDialogueContext',
      'DialogueProvider',
      'startIntent',
      'actionReceipts',
      'aiUsage',
    ];

    for (const identifier of forbiddenIdentifiers) {
      expect(
        source.includes(identifier),
        `Unexpected shared source identifier: ${identifier}`,
      ).toBe(false);
    }
    expect(files.length).toBeGreaterThanOrEqual(7);
  });
});
