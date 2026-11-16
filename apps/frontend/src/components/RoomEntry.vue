<script setup lang="ts">
import { ref } from 'vue';
import { useGameStore } from '../stores/game';
import GameStatusMessages from './GameStatusMessages.vue';

const game = useGameStore();
const code = ref('');
const createAttempted = ref(false);
const joinAttempted = ref(false);
const openingRecovered = ref(false);

async function create(): Promise<void> {
  createAttempted.value = true;
  if (await game.createRoom()) createAttempted.value = false;
}

async function join(): Promise<void> {
  joinAttempted.value = true;
  if (await game.joinRoom(code.value)) joinAttempted.value = false;
}

async function openRecovered(): Promise<void> {
  openingRecovered.value = true;
  try {
    await game.openRecoveredRoom();
  } finally {
    openingRecovered.value = false;
  }
}
</script>

<template>
  <div class="room-entry">
    <GameStatusMessages />
    <section
      v-if="game.lostSecret"
      class="error-summary secret-recovery"
      aria-labelledby="lost-secret-heading"
    >
      <h2 id="lost-secret-heading">Einladungscode nicht wiederherstellbar</h2>
      <p>
        Der idempotente Replay war erfolgreich, enthält aber absichtlich weder alten noch neuen
        Klartextcode. Öffne zuerst deinen noch autorisierten Raum. Dort kannst du als Host bewusst
        mit einer neuen Anfrage rotieren.
      </p>
      <button
        class="secondary-button"
        type="button"
        :disabled="openingRecovered"
        @click="openRecovered"
      >
        {{ openingRecovered ? 'Raum wird geladen …' : 'Autorisierten Raum öffnen' }}
      </button>
    </section>

    <div class="entry-grid">
      <section class="panel entry-panel" aria-labelledby="create-room-heading">
        <p class="eyebrow">Eigenes Team</p>
        <h2 id="create-room-heading">Privaten Raum erstellen</h2>
        <p>
          Du wirst Host und erhältst einmalig einen Einladungscode. Der Server speichert keinen
          Klartextcode für eine spätere Anzeige.
        </p>
        <button class="primary-button" type="button" :disabled="game.creating" @click="create">
          {{
            game.creating
              ? 'Raum wird erstellt …'
              : createAttempted
                ? 'Erstellung mit gleicher Anfrage prüfen'
                : 'Raum erstellen'
          }}
        </button>
      </section>

      <section class="panel entry-panel" aria-labelledby="join-room-heading">
        <p class="eyebrow">Mit Code beitreten</p>
        <h2 id="join-room-heading">Noch kein Raum geöffnet</h2>
        <p>Tritt einem privaten Raum mit dem aktuellen gruppierten Code des Hosts bei.</p>
        <form @submit.prevent="join">
          <label for="invitation-code-input">Einladungscode</label>
          <input
            id="invitation-code-input"
            v-model="code"
            class="code-input"
            type="text"
            inputmode="text"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            minlength="14"
            maxlength="14"
            placeholder="XXXX-XXXX-XXXX"
            required
            :disabled="game.joining"
            @input="code = code.toUpperCase()"
          />
          <span class="field-hint"
            >Format XXXX-XXXX-XXXX. Der alte Code gilt nach einer Rotation nicht mehr.</span
          >
          <button
            class="primary-button"
            type="submit"
            :disabled="game.joining || code.length !== 14"
          >
            {{
              game.joining
                ? 'Beitritt wird bestätigt …'
                : joinAttempted
                  ? 'Beitritt mit gleicher Anfrage prüfen'
                  : 'Raum beitreten'
            }}
          </button>
        </form>
      </section>
    </div>
    <p class="empty-state-note">
      Raumdaten und Einladungscodes werden nicht in Local- oder Session-Storage abgelegt.
    </p>
  </div>
</template>
