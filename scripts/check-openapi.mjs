import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const contractUrl = new URL('../contracts/openapi.yaml', import.meta.url);
const contractPath = fileURLToPath(contractUrl);
const errors = [];
const httpMethods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const requiredOperations = new Map([
  ['GET /health', { operationId: 'getHealth', response: '200' }],
  ['GET /ready', { operationId: 'getReadiness', response: '503' }],
  ['POST /auth/register', { operationId: 'register', response: '201' }],
  ['POST /auth/login', { operationId: 'login', response: '200' }],
  ['POST /auth/logout', { operationId: 'logout', response: '204' }],
  ['GET /me', { operationId: 'getMe', response: '200' }],
  ['POST /rooms', { operationId: 'createRoom', response: '201' }],
  ['POST /rooms/join', { operationId: 'joinRoom', response: '200' }],
  ['GET /rooms/{roomId}', { operationId: 'getRoom', response: '200' }],
  ['POST /rooms/{roomId}/invitation/rotate', { operationId: 'rotateInvitation', response: '200' }],
  ['POST /rooms/{roomId}/start', { operationId: 'startGame', response: '200' }],
  ['GET /cases', { operationId: 'listCases', response: '200' }],
  ['GET /sessions/{sessionId}', { operationId: 'getSession', response: '200' }],
  [
    'POST /sessions/{sessionId}/final-submission',
    { operationId: 'submitFinalSolution', response: '200' },
  ],
]);
const anonymousOperations = new Set([
  'GET /health',
  'GET /ready',
  'POST /auth/register',
  'POST /auth/login',
  'POST /auth/logout',
]);

function fail(message) {
  errors.push(message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveReference(reference, root) {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    throw new Error(`Only local JSON Pointer references are allowed: ${String(reference)}`);
  }

  let current = root;
  for (const encodedSegment of reference.slice(2).split('/')) {
    const segment = decodeURIComponent(encodedSegment).replaceAll('~1', '/').replaceAll('~0', '~');
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) {
      throw new Error(`Unresolvable local reference: ${reference}`);
    }
    current = current[segment];
  }
  return current;
}

function dereference(value, root) {
  if (!isRecord(value) || !Object.hasOwn(value, '$ref')) {
    return value;
  }
  return resolveReference(value['$ref'], root);
}

function collectReferences(value, references) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferences(item, references);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (Object.hasOwn(value, '$ref')) {
    references.add(value['$ref']);
  }
  for (const nested of Object.values(value)) {
    collectReferences(nested, references);
  }
}

function operationUsesCookieAuth(operation, rootSecurity) {
  const security = Object.hasOwn(operation, 'security') ? operation['security'] : rootSecurity;
  return (
    Array.isArray(security) &&
    security.some(
      (requirement) =>
        isRecord(requirement) &&
        Array.isArray(requirement['cookieAuth']) &&
        requirement['cookieAuth'].length === 0,
    )
  );
}

function parametersFor(pathItem, operation, root, label) {
  const parameters = [];
  for (const [level, owner] of [
    ['path item', pathItem],
    ['operation', operation],
  ]) {
    const declared = owner['parameters'] ?? [];
    if (!Array.isArray(declared)) {
      fail(`${label}: ${level} parameters must be an array`);
      continue;
    }
    for (const declaredParameter of declared) {
      try {
        const parameter = dereference(declaredParameter, root);
        if (!isRecord(parameter)) {
          fail(`${label}: ${level} contains a non-object parameter`);
          continue;
        }
        parameters.push(parameter);
      } catch (error) {
        fail(`${label}: ${error instanceof Error ? error.message : 'Invalid parameter reference'}`);
      }
    }
  }
  return parameters;
}

function validatePathParameters(path, pathItem, operation, root, label) {
  const placeholders = [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  if (new Set(placeholders).size !== placeholders.length) {
    fail(`${label}: duplicate placeholders in the path template`);
  }
  const parameters = parametersFor(pathItem, operation, root, label);

  for (const placeholder of placeholders) {
    const parameter = parameters.find(
      (candidate) => candidate['in'] === 'path' && candidate['name'] === placeholder,
    );
    if (parameter === undefined) {
      fail(`${label}: missing required path parameter {${placeholder}}`);
    } else if (parameter['required'] !== true) {
      fail(`${label}: path parameter ${placeholder} must set required: true`);
    }
  }

  for (const parameter of parameters) {
    if (parameter['in'] === 'path' && !placeholders.includes(parameter['name'])) {
      fail(`${label}: path parameter ${String(parameter['name'])} is absent from the template`);
    }
  }
}

try {
  const apiDocument = parse(readFileSync(contractPath, 'utf8'));
  if (!isRecord(apiDocument)) {
    throw new Error('The OpenAPI root must be an object');
  }
  if (apiDocument['openapi'] !== '3.1.0') {
    fail(`Expected OpenAPI 3.1.0, received ${String(apiDocument['openapi'])}`);
  }

  const references = new Set();
  collectReferences(apiDocument, references);
  for (const reference of references) {
    try {
      resolveReference(reference, apiDocument);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  const cookieScheme = apiDocument['components']?.['securitySchemes']?.['cookieAuth'];
  if (
    !isRecord(cookieScheme) ||
    cookieScheme['type'] !== 'apiKey' ||
    cookieScheme['in'] !== 'cookie' ||
    cookieScheme['name'] !== 'ct_session'
  ) {
    fail('components.securitySchemes.cookieAuth must describe the ct_session cookie');
  }

  const paths = apiDocument['paths'];
  if (!isRecord(paths)) {
    fail('OpenAPI paths must be an object');
  }

  const seenOperations = new Map();
  if (isRecord(paths)) {
    for (const [path, pathItem] of Object.entries(paths)) {
      if (!isRecord(pathItem)) {
        fail(`${path}: path item must be an object`);
        continue;
      }
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!httpMethods.has(method)) {
          continue;
        }
        const label = `${method.toUpperCase()} ${path}`;
        if (!isRecord(operation)) {
          fail(`${label}: operation must be an object`);
          continue;
        }
        const operationId = operation['operationId'];
        if (typeof operationId !== 'string' || operationId.length === 0) {
          fail(`${label}: operationId is required`);
        } else if (seenOperations.has(operationId)) {
          fail(
            `${label}: duplicate operationId ${operationId} also used by ${seenOperations.get(operationId)}`,
          );
        } else {
          seenOperations.set(operationId, label);
        }

        validatePathParameters(path, pathItem, operation, apiDocument, label);

        const requirement = requiredOperations.get(label);
        if (requirement !== undefined) {
          if (operationId !== requirement.operationId) {
            fail(`${label}: expected operationId ${requirement.operationId}`);
          }
          const responses = operation['responses'];
          if (!isRecord(responses) || !Object.hasOwn(responses, requirement.response)) {
            fail(`${label}: required response ${requirement.response} is missing`);
          }
        }

        if (anonymousOperations.has(label)) {
          if (!Array.isArray(operation['security']) || operation['security'].length !== 0) {
            fail(`${label}: anonymous operation must explicitly set security: []`);
          }
        } else if (!operationUsesCookieAuth(operation, apiDocument['security'])) {
          fail(`${label}: protected operation must use cookieAuth`);
        }
      }
    }
  }

  for (const [label, requirement] of requiredOperations) {
    if (!seenOperations.has(requirement.operationId)) {
      fail(`${label}: mandatory operation ${requirement.operationId} is missing`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`OpenAPI ERROR: ${error}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `OpenAPI OK: 3.1.0; ${seenOperations.size} operations; ${references.size} local references; path parameters and cookieAuth valid`,
    );
  }
} catch (error) {
  console.error(
    `OpenAPI ERROR: ${contractPath}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
