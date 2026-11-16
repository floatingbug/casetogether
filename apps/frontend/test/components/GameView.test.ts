import {
  CatalogQuestionRequestSchema,
  FinalSubmissionRequestSchema,
  GameSnapshotSchema,
} from '@casetogether/shared';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GameView from '../../src/components/GameView.vue';
import { useAuthStore } from '../../src/stores/auth';
import { useGameStore } from '../../src/stores/game';
import { testUser } from '../fixtures';
import {
  activeRoomSnapshot,
  completedGame,
  investigatingGame,
  suspectAnsweredEvent,
} from '../game-fixtures';

let pinia: Pinia;
let wrapper: VueWrapper | undefined;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().setUser(testUser);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.unstubAllGlobals();
});

function mountGame(game = investigatingGame()) {
  const store = useGameStore();
  store.$patch({ room: activeRoomSnapshot(), game, connectionStatus: 'connected' });
  wrapper = mount(GameView, { global: { plugins: [pinia] } });
  return store;
}

describe('catalog game components', () => {
  it('offers explicit catalog questions without a free-text interrogation field or provider UI', async () => {
    const store = mountGame();
    const ask = vi.spyOn(store, 'askCatalog').mockResolvedValue(true);

    expect(wrapper?.text()).toContain('Freitext ist nicht erforderlich');
    expect(wrapper?.findAll('button.question-button')).toHaveLength(1);
    expect(wrapper?.text()).toContain('Wo waren Sie um Mitternacht?');
    expect(wrapper?.find('input[placeholder*="Verdächtigen fragen"]').exists()).toBe(false);
    expect(wrapper?.text()).not.toContain('API-Schlüssel eingeben');

    await wrapper?.get('button.question-button').trigger('click');
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 'question_alibi', suspectId: 'suspect_ada' }),
    );
    expect(wrapper?.find('.resolution-panel').exists()).toBe(false);
    expect(wrapper?.find('.verdict').exists()).toBe(false);
  });

  it('renders only projected dialogues/clues as escaped server data', () => {
    const event = suspectAnsweredEvent(2);
    const dialogue = event.payload.dialogue;
    if (dialogue === null) throw new Error('Dialogue expected');
    const game = GameSnapshotSchema.parse({
      ...investigatingGame(2),
      dialogues: [
        { ...dialogue, answerText: '<img src=x onerror="globalThis.compromised=true">Referenz' },
      ],
      publicClues: event.payload.newPublicClues,
      privateClues: event.payload.newPrivateClues,
    });
    mountGame(game);

    expect(wrapper?.text()).toContain('Katalog-Referenzantwort');
    expect(wrapper?.text()).toContain('<img src=x');
    expect(wrapper?.find('img').exists()).toBe(false);
    expect(wrapper?.text()).toContain('Seiteneingang');
    expect(wrapper?.text()).toContain('Deine privaten Hinweise');
    expect(wrapper?.text()).toContain('Eigene Beobachtung');
    expect(globalThis).not.toHaveProperty('compromised');
  });

  it('shows a pending question without inventing an answer, clue or next version', async () => {
    const store = mountGame();
    store.$patch({
      pendingQuestion: {
        questionText: 'Wo waren Sie um Mitternacht?',
        request: CatalogQuestionRequestSchema.parse({
          mode: 'catalog',
          sessionId: 'session_fixture',
          clientRequestId: '5c6088d1-710f-4d58-a1d4-8d866fa43a6d',
          expectedVersion: 1,
          suspectId: 'suspect_ada',
          questionId: 'question_alibi',
        }),
      },
    });

    await wrapper?.vm.$nextTick();
    expect(wrapper?.text()).toContain('Antwort noch nicht bestätigt');
    expect(wrapper?.text()).not.toContain('Im Archiv; der Seiteneingang war verschlossen.');
    expect(wrapper?.text()).not.toContain('Eigene Beobachtung');
    expect(wrapper?.get('.version-badge').text()).toBe('Stand 1');
  });

  it('reveals no optimistic final result and renders resolution only after a completed server snapshot', async () => {
    const store = mountGame();
    store.$patch({
      pendingFinal: {
        ...FinalSubmissionRequestSchema.parse({
          clientRequestId: '5c6088d1-710f-4d58-a1d4-8d866fa43a6d',
          expectedVersion: 1,
          suspectId: 'suspect_ada',
        }),
        sessionId: 'session_fixture',
      },
    });

    await wrapper?.vm.$nextTick();
    expect(wrapper?.text()).toContain('Finale Abgabe unbestätigt');
    expect(wrapper?.text()).toContain('Es gibt noch kein Ergebnis und keine Auflösung');
    expect(wrapper?.find('.resolution-panel').exists()).toBe(false);
    expect(wrapper?.text()).not.toContain('Der verschlossene Seiteneingang');

    store.$patch({ game: completedGame(2), pendingFinal: null });
    await wrapper?.vm.$nextTick();
    expect(wrapper?.get('.resolution-panel').text()).toContain('Vom Server bestätigt');
    expect(wrapper?.text()).toContain('80/100 Punkte');
    expect(wrapper?.text()).toContain('Der verschlossene Seiteneingang');
    expect(wrapper?.find('.final-panel').exists()).toBe(false);
  });

  it('has separate accessible empty states for public and actor-private clues', () => {
    mountGame();
    expect(wrapper?.text()).toContain('Noch keine gemeinsamen Hinweise.');
    expect(wrapper?.text()).toContain('Du hast noch keine privaten Hinweise.');
    expect(wrapper?.text()).toContain('Noch keine bestätigten Dialoge');
    expect(wrapper?.get('.private-clues').text()).toContain('Nur für dich');
  });
});
