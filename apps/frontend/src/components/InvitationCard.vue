<script setup lang="ts">
import { ref } from 'vue';
import { useGameStore } from '../stores/game';

const game = useGameStore();
const copyStatus = ref('');

async function copyInvitation(): Promise<void> {
  const code = game.invitation?.code;
  if (code === undefined) return;
  copyStatus.value = '';
  try {
    await globalThis.navigator.clipboard.writeText(code);
    copyStatus.value = 'Code kopiert. Er wurde nicht dauerhaft im Browser gespeichert.';
  } catch {
    copyStatus.value =
      'Automatisches Kopieren ist nicht möglich. Markiere den Code und kopiere ihn manuell.';
  }
}

function localTime(value: string): string {
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
</script>

<template>
  <section class="panel invitation-panel" aria-labelledby="invitation-heading">
    <p class="eyebrow">Privater Zugang</p>
    <h2 id="invitation-heading">Einladung</h2>

    <template v-if="game.invitation">
      <p class="invitation-warning">
        Dieser Klartextcode erscheint nur direkt nach dem Erstellen oder Rotieren. Teile ihn nur mit
        deinem Ermittlerteam.
      </p>
      <output class="invitation-code" aria-label="Aktueller Einladungscode">{{
        game.invitation.code
      }}</output>
      <p class="field-hint">Gültig bis {{ localTime(game.invitation.expiresAt) }}.</p>
      <button class="secondary-button" type="button" @click="copyInvitation">Code kopieren</button>
      <p v-if="copyStatus" class="field-hint" role="status">{{ copyStatus }}</p>
    </template>

    <p v-else class="notice">
      Es ist kein Klartextcode mehr in dieser Sitzung verfügbar. Der Server kann verlorene Codes
      nicht rekonstruieren. Erzeuge bei Bedarf bewusst einen neuen Code.
    </p>
    <p v-if="game.lostSecret" class="field-hint">
      Der bestätigte Replay war codefrei. Eine neue Rotation benötigt eine neue Anfrage und macht
      den bisherigen Code ungültig.
    </p>
    <button
      class="secondary-button rotate-button"
      type="button"
      :disabled="game.rotating || game.synchronizing || !game.isHost"
      @click="game.rotateInvitation"
    >
      {{ game.rotating ? 'Neuer Code wird erzeugt …' : 'Neuen Code durch Rotation erzeugen' }}
    </button>
    <p class="field-hint">Beim Rotieren wird der alte Code sofort ungültig.</p>
  </section>
</template>
