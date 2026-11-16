<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useGameStore } from '../stores/game';

const auth = useAuthStore();
const game = useGameStore();
const members = computed(() => game.room?.room.members ?? []);

function presenceFor(userId: string): string {
  const status = game.room?.presence.find((member) => member.userId === userId)?.status;
  if (status === 'online') return 'online';
  if (status === 'offline') return 'offline';
  return 'Präsenz wird geladen';
}
</script>

<template>
  <section class="panel member-panel" aria-labelledby="members-heading">
    <div class="panel-heading-row">
      <h2 id="members-heading">Ermittlerteam</h2>
      <span class="count-badge">{{ members.length }}/4</span>
    </div>
    <ul class="member-list">
      <li v-for="member in members" :key="member.user.id">
        <div>
          <strong>{{ member.user.displayName }}</strong>
          <span v-if="member.user.id === auth.user?.id" class="field-hint"> (du)</span>
          <p class="field-hint">{{ member.role === 'host' ? 'Host' : 'Mitglied' }}</p>
        </div>
        <span class="presence-label" :data-presence="presenceFor(member.user.id)">
          <span class="presence-dot" aria-hidden="true"></span>
          {{ presenceFor(member.user.id) }}
        </span>
      </li>
    </ul>
    <p v-if="members.length < 2" class="field-hint">
      Mindestens ein weiteres Mitglied muss beitreten, bevor der Host starten kann.
    </p>
  </section>
</template>
