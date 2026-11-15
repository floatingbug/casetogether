<script setup lang="ts">
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
</script>

<template>
  <div class="lobby-layout">
    <section class="lobby-hero" aria-labelledby="lobby-title">
      <p class="eyebrow">Deine Lobby</p>
      <h1 id="lobby-title">Willkommen, {{ auth.user?.displayName }}.</h1>
      <p class="lead">Hier beginnt eure nächste gemeinsame Ermittlung.</p>
    </section>

    <section class="empty-state" aria-labelledby="empty-lobby-title">
      <span class="empty-state-mark" aria-hidden="true">CT</span>
      <div>
        <h2 id="empty-lobby-title">Noch kein Raum geöffnet</h2>
        <p>
          Dein Konto ist bereit. Private Räume und Fallauswahl werden mit den nächsten
          Arbeitspaketen hier verfügbar.
        </p>
      </div>
      <p class="empty-state-note">Es liegen keine Raum- oder Spieldaten auf diesem Gerät.</p>
    </section>
  </div>
</template>
