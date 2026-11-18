const EXAMPLE_ORIGIN = 'https://api.example.com';

/**
 * Normalizes the optional build-time backend origin (`VITE_API_ORIGIN`).
 *
 * An empty value keeps the historical same-origin behavior: REST requests stay relative and
 * Socket.IO connects to the document origin. A configured value must be a bare absolute origin
 * without path, query, hash or credentials. `https:` is always allowed; `http:` is only allowed
 * for local development against `localhost` or `127.0.0.1`.
 */
export function normalizeApiOrigin(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) {
    return '';
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return '';
  }

  const candidate = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (error: unknown) {
    throw new Error(
      `VITE_API_ORIGIN must be an absolute origin such as ${EXAMPLE_ORIGIN} (received "${trimmed}")`,
      { cause: error },
    );
  }

  if (parsed.origin === 'null' || parsed.origin !== candidate) {
    throw new Error(
      `VITE_API_ORIGIN must not contain a path, query, hash or credentials; use a bare origin such as ${EXAMPLE_ORIGIN} (received "${trimmed}")`,
    );
  }

  if (parsed.protocol === 'https:') {
    return parsed.origin;
  }

  if (
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  ) {
    return parsed.origin;
  }

  throw new Error(
    `VITE_API_ORIGIN must use https; plain http is only allowed for localhost or 127.0.0.1 (received "${trimmed}")`,
  );
}

export const API_ORIGIN = normalizeApiOrigin(import.meta.env.VITE_API_ORIGIN);
