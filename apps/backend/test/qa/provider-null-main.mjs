import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname } from 'node:path';

const evidencePath = process.env['T010_PROVIDER_EVIDENCE_FILE'];
if (evidencePath === undefined || evidencePath.length === 0) {
  throw new Error('T010_PROVIDER_EVIDENCE_FILE is required for the QA production-main guard');
}

for (const key of Object.keys(process.env)) {
  if (/OPENAI|ANTHROPIC|GEMINI|AZURE|AI_PROVIDER/i.test(key)) {
    delete process.env[key];
  }
}

const evidence = {
  guard: 't010-provider-null-production-main',
  providerEnvironmentKeysAfterSanitization: Object.keys(process.env).filter((key) =>
    /OPENAI|ANTHROPIC|GEMINI|AZURE|AI_PROVIDER/i.test(key),
  ),
  providerTransportAttempts: [],
  productionMainImported: false,
};

function persistEvidence() {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

function hostnameFrom(input) {
  if (typeof input === 'string') return new URL(input).hostname;
  if (input instanceof URL) return input.hostname;
  if (typeof input === 'object' && input !== null) {
    const hostname = Reflect.get(input, 'hostname') ?? Reflect.get(input, 'host');
    return typeof hostname === 'string' ? hostname : 'unbekannt';
  }
  return 'unbekannt';
}

function rejectProviderTransport(transport, input) {
  evidence.providerTransportAttempts.push({ transport, hostname: hostnameFrom(input) });
  persistEvidence();
  throw new Error(`T010 blocked provider/network transport: ${transport}`);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (input) => rejectProviderTransport('fetch', input);
const originalHttpRequest = http.request;
const originalHttpGet = http.get;
const originalHttpsRequest = https.request;
const originalHttpsGet = https.get;
http.request = (input) => rejectProviderTransport('http.request', input);
http.get = (input) => rejectProviderTransport('http.get', input);
https.request = (input) => rejectProviderTransport('https.request', input);
https.get = (input) => rejectProviderTransport('https.get', input);

persistEvidence();
process.on('exit', () => {
  globalThis.fetch = originalFetch;
  http.request = originalHttpRequest;
  http.get = originalHttpGet;
  https.request = originalHttpsRequest;
  https.get = originalHttpsGet;
  persistEvidence();
});

await import('../../src/main.ts');
evidence.productionMainImported = true;
persistEvidence();
