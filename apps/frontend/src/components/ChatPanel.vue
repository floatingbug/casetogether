<script setup lang="ts">
import { ref } from 'vue';
import { useGameStore } from '../stores/game';

const game = useGameStore();
const message = ref('');

async function send(): Promise<void> {
  const submitted = message.value;
  if (await game.sendChat(submitted)) {
    if (message.value === submitted) message.value = '';
  }
}

function localTime(value: string): string {
  return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value),
  );
}
</script>

<template>
  <section class="panel chat-panel" aria-labelledby="chat-heading">
    <div class="panel-heading-row">
      <div>
        <p class="eyebrow">Abstimmung</p>
        <h2 id="chat-heading">Gruppenchat</h2>
      </div>
      <span class="field-hint">live</span>
    </div>

    <div v-if="!game.room" class="empty-inline" role="status">Chat wird geladen …</div>
    <template v-else>
      <ol
        v-if="game.room.recentMessages.length > 0"
        class="chat-messages"
        aria-label="Letzte Nachrichten"
      >
        <li v-for="item in game.room.recentMessages" :key="item.id">
          <div class="chat-meta">
            <strong>{{ item.sender.displayName }}</strong>
            <time :datetime="item.createdAt">{{ localTime(item.createdAt) }}</time>
          </div>
          <p>{{ item.content }}</p>
        </li>
      </ol>
      <p v-else class="empty-inline">Noch keine Nachrichten. Stimmt euch hier ab.</p>

      <div v-if="game.pendingChat" class="pending-card" role="status">
        <strong>Nachricht unbestätigt</strong>
        <p>{{ game.pendingChat.content }}</p>
        <button
          class="secondary-button compact-button"
          type="button"
          :disabled="game.sendingChat || game.connectionStatus !== 'connected'"
          @click="game.retryChat"
        >
          {{ game.sendingChat ? 'Ausgang wird geprüft …' : 'Mit gleicher Anfrage erneut prüfen' }}
        </button>
      </div>

      <form class="chat-form" @submit.prevent="send">
        <label for="room-chat">Nachricht an den Raum</label>
        <textarea
          id="room-chat"
          v-model="message"
          rows="3"
          maxlength="1000"
          required
          :disabled="
            game.sendingChat || game.pendingChat !== null || game.connectionStatus !== 'connected'
          "
          placeholder="Besprecht Hinweise und eure nächste Frage …"
        ></textarea>
        <span class="field-hint"
          >{{ message.length }}/1000 Zeichen · Text wird escaped dargestellt.</span
        >
        <button
          class="primary-button"
          type="submit"
          :disabled="
            message.trim().length === 0 ||
            game.sendingChat ||
            game.pendingChat !== null ||
            game.connectionStatus !== 'connected'
          "
        >
          {{ game.sendingChat ? 'Nachricht wird bestätigt …' : 'Nachricht senden' }}
        </button>
      </form>
    </template>
  </section>
</template>
