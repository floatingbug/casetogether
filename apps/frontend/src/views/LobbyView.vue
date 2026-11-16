<script setup lang="ts">
import GameView from '../components/GameView.vue';
import RoomEntry from '../components/RoomEntry.vue';
import RoomLobby from '../components/RoomLobby.vue';
import GameStatusMessages from '../components/GameStatusMessages.vue';
import { useAuthStore } from '../stores/auth';
import { useGameStore } from '../stores/game';

const auth = useAuthStore();
const game = useGameStore();
</script>

<template>
  <div class="play-layout">
    <section class="lobby-hero" aria-labelledby="lobby-title">
      <p class="eyebrow">{{ game.game ? 'Gemeinsame Ermittlung' : 'Deine Lobby' }}</p>
      <h1 id="lobby-title">Willkommen, {{ auth.user?.displayName }}.</h1>
      <p class="lead">
        {{
          game.game
            ? 'Befragt Verdächtige, sammelt Hinweise und entscheidet gemeinsam.'
            : 'Erstelle einen privaten Raum oder tritt deinem Ermittlerteam bei.'
        }}
      </p>
    </section>

    <GameView v-if="game.game" />
    <template v-else-if="game.room">
      <div v-if="game.room.room.status === 'in_progress'" class="panel loading-state" role="status">
        <GameStatusMessages />
        <h2>Die Game Session wird geladen</h2>
        <p>
          Der Raum ist gestartet. Die Oberfläche wartet auf deinen autoritativen Spiel-Snapshot.
        </p>
        <button
          class="secondary-button"
          type="button"
          :disabled="game.synchronizing"
          @click="game.syncRoom"
        >
          Spielstand laden
        </button>
      </div>
      <RoomLobby v-else />
    </template>
    <RoomEntry v-else />
  </div>
</template>
