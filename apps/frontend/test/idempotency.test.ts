import { ClientRequestIdSchema } from '@casetogether/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newClientRequestId } from '../src/idempotency';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('newClientRequestId', () => {
  it('uses randomUUID when available and skips the fallback', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const randomUUID = vi.fn(() => uuid);
    const getRandomValues = vi.fn();
    vi.stubGlobal('crypto', { randomUUID, getRandomValues });

    expect(newClientRequestId()).toBe(uuid);
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('creates distinct RFC UUID v4 values from CSPRNG bytes without Math.random', () => {
    let fill = 0;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(fill);
      fill += 1;
      return bytes;
    });
    vi.stubGlobal('crypto', { randomUUID: undefined, getRandomValues });
    const mathRandom = vi.spyOn(Math, 'random');

    const first = newClientRequestId();
    const second = newClientRequestId();

    expect(ClientRequestIdSchema.parse(first)).toBe(first);
    expect(ClientRequestIdSchema.parse(second)).toBe(second);
    expect(first.split('-')[2]).toMatch(/^4[0-9a-f]{3}$/);
    expect(first.split('-')[3]).toMatch(/^[89ab][0-9a-f]{3}$/);
    expect(first).not.toBe(second);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
    expect(getRandomValues.mock.calls[0]?.[0]).toHaveLength(16);
    expect(mathRandom).not.toHaveBeenCalled();
  });
});
