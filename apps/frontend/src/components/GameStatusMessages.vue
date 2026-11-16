<script setup lang="ts">
import { useGameStore } from '../stores/game';

const game = useGameStore();
</script>

<template>
  <div class="status-stack" aria-live="polite" aria-atomic="false">
    <p v-if="game.errorMessage" class="error-summary" role="alert">{{ game.errorMessage }}</p>
    <p v-if="game.noticeMessage" class="notice" role="status">{{ game.noticeMessage }}</p>
    <div
      v-if="
        game.room &&
        ['connecting', 'synchronizing', 'reconnecting', 'offline', 'error'].includes(
          game.connectionStatus,
        )
      "
      class="connection-card"
      role="status"
    >
      <strong v-if="game.connectionStatus === 'offline'">Offline</strong>
      <strong v-else-if="game.connectionStatus === 'reconnecting'"
        >Verbindung wird wiederhergestellt</strong
      >
      <strong v-else>Serverstand wird synchronisiert</strong>
      <span>
        Angezeigt werden nur zuletzt bestätigte Serverdaten. Neue Aktionen sind erst nach einer
        erfolgreichen Verbindung möglich.
      </span>
      <button
        class="secondary-button compact-button"
        type="button"
        :disabled="game.synchronizing || game.pendingLeave !== null"
        @click="game.syncRoom"
      >
        {{ game.synchronizing ? 'Synchronisierung …' : 'Serverstand neu laden' }}
      </button>
    </div>
  </div>
</template>
