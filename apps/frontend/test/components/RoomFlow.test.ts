import { ChatSendRequestSchema } from '@casetogether/shared';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatPanel from '../../src/components/ChatPanel.vue';
import InvitationCard from '../../src/components/InvitationCard.vue';
import RoomEntry from '../../src/components/RoomEntry.vue';
import { useAuthStore } from '../../src/stores/auth';
import { useGameStore } from '../../src/stores/game';
import { testUser } from '../fixtures';
import { invitationCode, readyRoomSnapshot, waitingRoomResponse } from '../game-fixtures';

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
  Reflect.deleteProperty(globalThis.navigator, 'clipboard');
  vi.unstubAllGlobals();
});

describe('room entry and invitation states', () => {
  it('submits create and normalized join through store actions, not component fetch logic', async () => {
    const store = useGameStore();
    const create = vi.spyOn(store, 'createRoom').mockResolvedValue(true);
    const join = vi.spyOn(store, 'joinRoom').mockResolvedValue(true);
    wrapper = mount(RoomEntry, { global: { plugins: [pinia] } });

    await wrapper.get('#create-room-heading + p + button').trigger('click');
    await wrapper.get('#invitation-code-input').setValue(invitationCode.toLowerCase());
    await wrapper.get('form').trigger('submit');

    expect(create).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledWith(invitationCode);
    expect(wrapper.text()).toContain('Local- oder Session-Storage');
  });

  it('makes code-free replay and deliberate recovery explicit without displaying an old code', () => {
    const store = useGameStore();
    store.$patch({
      lostSecret: {
        outcome: 'replayed',
        roomId: 'room_fixture',
        invitation: null,
        recovery: 'rotate_with_new_client_request_id_if_needed',
      },
    });
    wrapper = mount(RoomEntry, { global: { plugins: [pinia] } });

    expect(wrapper.text()).toContain('Einladungscode nicht wiederherstellbar');
    expect(wrapper.text()).toContain('neuen Anfrage');
    expect(wrapper.text()).not.toContain(invitationCode);
    expect(wrapper.get('.secret-recovery button').text()).toContain('Autorisierten Raum öffnen');
  });

  it('copies only the live one-time invitation and offers explicit rotation', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const store = useGameStore();
    const snapshot = readyRoomSnapshot();
    store.$patch({
      room: snapshot,
      invitation: waitingRoomResponse().invitation,
      connectionStatus: 'connected',
    });
    const rotate = vi.spyOn(store, 'rotateInvitation').mockResolvedValue(true);
    wrapper = mount(InvitationCard, { global: { plugins: [pinia] } });

    expect(wrapper.get('.invitation-code').text()).toBe(invitationCode);
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(invitationCode);
    expect(wrapper.text()).toContain('Code kopiert');
    await wrapper.get('.rotate-button').trigger('click');
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('describes lost rotation without guessing either old or new code', () => {
    const store = useGameStore();
    store.$patch({
      room: readyRoomSnapshot(),
      lostSecret: {
        outcome: 'replayed',
        roomId: 'room_fixture',
        invitation: null,
        recovery: 'rotate_with_new_client_request_id_if_needed',
      },
    });
    wrapper = mount(InvitationCard, { global: { plugins: [pinia] } });

    expect(wrapper.text()).toContain('nicht rekonstruieren');
    expect(wrapper.text()).toContain('Replay war codefrei');
    expect(wrapper.text()).not.toContain(invitationCode);
    expect(wrapper.get('.rotate-button').text()).toContain('Neuen Code durch Rotation');
  });
});

describe('chat pending and empty states', () => {
  it('keeps an unconfirmed message separate from the authoritative chronology', () => {
    const store = useGameStore();
    store.$patch({
      room: readyRoomSnapshot(),
      connectionStatus: 'connected',
      pendingChat: ChatSendRequestSchema.parse({
        roomId: 'room_fixture',
        clientRequestId: '5c6088d1-710f-4d58-a1d4-8d866fa43a6d',
        content: 'Unbestätigte Fixture-Nachricht',
      }),
    });
    wrapper = mount(ChatPanel, { global: { plugins: [pinia] } });

    expect(wrapper.findAll('.chat-messages li')).toHaveLength(0);
    expect(wrapper.get('.pending-card').text()).toContain('Nachricht unbestätigt');
    expect(wrapper.get('.pending-card').text()).toContain('Unbestätigte Fixture-Nachricht');
    expect(wrapper.get('#room-chat').attributes('disabled')).toBeDefined();
  });
});
