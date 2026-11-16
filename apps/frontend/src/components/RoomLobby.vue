<script setup lang="ts">
import { watch } from 'vue';
import CasePicker from './CasePicker.vue';
import ChatPanel from './ChatPanel.vue';
import GameStatusMessages from './GameStatusMessages.vue';
import InvitationCard from './InvitationCard.vue';
import MemberList from './MemberList.vue';
import { useGameStore } from '../stores/game';

const game = useGameStore();

watch(
  () => game.isHost,
  (isHost) => {
    if (isHost) void game.loadCases();
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="game.room" class="room-lobby">
    <GameStatusMessages />

    <section v-if="game.room.room.status === 'closed'" class="panel closed-panel" role="status">
      <p class="eyebrow">Raum geschlossen</p>
      <h2>Diese Lobby ist beendet</h2>
      <p>
        Die letzten autorisierten Lobbydaten bleiben sichtbar. Beitritt, Chat und Start sind
        gesperrt.
      </p>
    </section>

    <div v-else class="lobby-grid">
      <div class="lobby-main-column">
        <InvitationCard v-if="game.isHost" />
        <CasePicker />
      </div>
      <div class="lobby-side-column">
        <MemberList />
        <ChatPanel />
      </div>
    </div>

    <section v-if="game.room.room.status !== 'closed'" class="leave-section">
      <p class="field-hint">
        {{
          game.isHost
            ? 'Als Host schließt du mit dem Verlassen die Lobby für das Team.'
            : 'Ein Verbindungsabbruch allein verlässt den Raum nicht.'
        }}
      </p>
      <button class="danger-button" type="button" :disabled="game.leaving" @click="game.leaveRoom">
        {{
          game.leaving
            ? 'Verlassen wird bestätigt …'
            : game.isHost
              ? 'Verlassen und Lobby schließen'
              : 'Lobby verlassen'
        }}
      </button>
      <p v-if="game.pendingLeave" class="notice" role="status">
        Verlassen unbestätigt. Beim Reconnect wird exakt diese Anfrage ohne vorherigen Raumbeitritt
        wiederholt.
      </p>
    </section>
  </div>
</template>
