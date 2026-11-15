import type { LocationQueryValue } from 'vue-router';

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function safeInternalPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    containsControlCharacter(value)
  ) {
    return '/';
  }
  return value;
}

export function redirectAfterLogin(
  value: LocationQueryValue | LocationQueryValue[] | undefined,
): string {
  return safeInternalPath(Array.isArray(value) ? undefined : (value ?? undefined));
}
