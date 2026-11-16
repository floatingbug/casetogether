<script setup lang="ts">
import { computed, ref } from 'vue';
import { useGameStore } from '../stores/game';

const game = useGameStore();
const selectedCaseId = ref('');
const selectedCase = computed(() => game.cases.find((item) => item.id === selectedCaseId.value));
const canStart = computed(
  () =>
    game.isHost &&
    game.room?.room.status === 'ready' &&
    game.room.room.members.length >= 2 &&
    game.room.room.members.length <= 4 &&
    selectedCaseId.value !== '' &&
    !game.starting &&
    game.connectionStatus === 'connected',
);

async function loadCases(): Promise<void> {
  await game.loadCases(true);
}

async function start(): Promise<void> {
  const item = selectedCase.value;
  if (!canStart.value || item === undefined) return;
  await game.startGame(item.id);
}
</script>

<template>
  <section class="panel case-panel" aria-labelledby="case-heading">
    <div class="panel-heading-row">
      <div>
        <p class="eyebrow">Fallauswahl</p>
        <h2 id="case-heading">Worum geht es?</h2>
      </div>
      <button
        class="secondary-button compact-button"
        type="button"
        :disabled="game.loadingCases"
        @click="loadCases"
      >
        {{ game.loadingCases ? 'Fälle werden geladen …' : 'Aktualisieren' }}
      </button>
    </div>

    <p v-if="game.loadingCases && !game.casesLoaded" class="loading-state" role="status">
      Veröffentlichte Fälle werden vom Server geladen …
    </p>
    <div v-else-if="game.casesLoaded && game.cases.length === 0" class="empty-inline">
      <strong>Aktuell ist kein Fall verfügbar.</strong>
      <p>Bitte versuche es später erneut. Es wird kein Ersatzfall im Browser erzeugt.</p>
    </div>
    <form v-else-if="game.cases.length > 0" @submit.prevent="start">
      <fieldset class="case-list" :disabled="!game.isHost || game.starting">
        <legend class="sr-only">Verfügbare Fälle</legend>
        <label v-for="item in game.cases" :key="item.id" class="case-option">
          <input v-model="selectedCaseId" type="radio" name="case" :value="item.id" />
          <span>
            <strong>{{ item.title }}</strong>
            <span>{{ item.description }}</span>
            <small>ca. {{ item.estimatedDurationMinutes }} Minuten</small>
          </span>
        </label>
      </fieldset>
      <p v-if="!game.isHost" class="notice">Nur der Host kann den ausgewählten Fall starten.</p>
      <p v-else-if="game.room?.room.status !== 'ready'" class="field-hint">
        Der Start wird bei 2–4 Mitgliedern freigeschaltet. Der Server prüft dies erneut.
      </p>
      <button class="primary-button" type="submit" :disabled="!canStart">
        {{ game.starting ? 'Fall wird gestartet …' : 'Fall gemeinsam starten' }}
      </button>
    </form>
    <p v-else class="field-hint">Wähle „Aktualisieren“, um verfügbare Fälle zu laden.</p>
  </section>
</template>
