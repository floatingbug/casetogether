import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCompleteGame, snapshot, testUsers } from './helpers.js';

describe('deterministic reference-only execution', () => {
  it('produces byte-identical JSON for repeated complete games', () => {
    const first = runCompleteGame('byte-identical');
    const second = runCompleteGame('byte-identical');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first.state)).toBe(JSON.stringify(second.state));
    expect(JSON.stringify(snapshot(first.state))).toBe(JSON.stringify(snapshot(second.state)));
    expect(first.final.eventId).toBe(second.final.eventId);
    expect(first.final.recipientEvents).toEqual(second.final.recipientEvents);
  });

  it('uses only injected timestamps and never reads the wall clock', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Wall-clock access is forbidden in the engine');
    });
    const game = runCompleteGame('no-wall-clock');
    expect(now).not.toHaveBeenCalled();
    expect(game.state.startedAt).toBe('2026-11-15T20:00:01.000Z');
    expect(game.state.finishedAt).toBe('2026-11-15T20:01:30.000Z');
    expect(game.state.result?.verdict).toBe('correct');
    now.mockRestore();
  });

  it('uses reference answers on the entire path with zero fetch/provider calls and no provider port', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Network access is forbidden in the engine');
    });
    const first = runCompleteGame('reference-only');
    const second = runCompleteGame('reference-only');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    for (const state of [first.state, second.state]) {
      const host = snapshot(state, testUsers.host.id);
      const guest = snapshot(state, testUsers.guest.id);
      expect(host.dialogues).toHaveLength(9);
      expect(guest.dialogues).toHaveLength(7);
      expect(
        [...host.dialogues, ...guest.dialogues].every(
          (dialogue) => dialogue.answerSource === 'reference',
        ),
      ).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    const engineDirectory = fileURLToPath(new URL('../../src/game-engine/', import.meta.url));
    const sourceFiles = readdirSync(engineDirectory, { recursive: true })
      .map((entry) => entry.toString())
      .filter((entry) => entry.endsWith('.ts'));
    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const sourceFile of sourceFiles) {
      const source = readFileSync(join(engineDirectory, sourceFile), 'utf8');
      expect(source).not.toMatch(/generateDialogue|fetch\s*\(|node:http|node:https|\/ai\//);
      expect(source).not.toMatch(/OPENAI|API_KEY|ProviderConfig/);
    }
    fetchSpy.mockRestore();
  });
});
