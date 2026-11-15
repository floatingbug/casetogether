<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

const isOffline = ref(false);

function updateConnectionState(): void {
  isOffline.value = !globalThis.navigator.onLine;
}

onMounted(() => {
  updateConnectionState();
  globalThis.addEventListener('online', updateConnectionState);
  globalThis.addEventListener('offline', updateConnectionState);
});

onBeforeUnmount(() => {
  globalThis.removeEventListener('online', updateConnectionState);
  globalThis.removeEventListener('offline', updateConnectionState);
});
</script>

<template>
  <div v-if="isOffline" class="offline-notice" role="status">
    <strong>Du bist offline.</strong>
    Die neuesten Serverdaten sind nicht verfügbar. Sobald du wieder online bist, kannst du es erneut
    versuchen.
  </div>
</template>
