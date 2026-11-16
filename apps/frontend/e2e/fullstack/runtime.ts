import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const runtimeStateSchema = z.object({
  backendOrigin: z.string().url(),
  frontendOrigin: z.string().url(),
  mongoUri: z.string().startsWith('mongodb://127.0.0.1:'),
  databaseName: z.literal('casetogether_t010_fullstack'),
  providerEvidencePath: z.string().min(1),
  backendLogPath: z.string().min(1),
});

const providerEvidenceSchema = z.object({
  guard: z.literal('t010-provider-null-production-main'),
  providerEnvironmentKeysAfterSanitization: z.array(z.string()),
  providerTransportAttempts: z.array(z.object({ transport: z.string(), hostname: z.string() })),
  productionMainImported: z.literal(true),
});

export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export type ProviderEvidence = z.infer<typeof providerEvidenceSchema>;

export function artifactDirectory(): string {
  return process.env['T010_ARTIFACT_DIR'] ?? '/tmp/opencode/casetogether-t010-fullstack';
}

export function artifactPath(filename: string): string {
  return join(artifactDirectory(), filename);
}

export async function readRuntimeState(): Promise<RuntimeState> {
  const body: unknown = JSON.parse(await readFile(artifactPath('runtime.json'), 'utf8'));
  return runtimeStateSchema.parse(body);
}

export async function readProviderEvidence(): Promise<ProviderEvidence> {
  const state = await readRuntimeState();
  const body: unknown = JSON.parse(await readFile(state.providerEvidencePath, 'utf8'));
  return providerEvidenceSchema.parse(body);
}

export async function readBackendLog(): Promise<string> {
  const state = await readRuntimeState();
  return readFile(state.backendLogPath, 'utf8');
}
