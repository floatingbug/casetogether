<script setup lang="ts">
import { useRouter } from 'vue-router';
import ConnectivityNotice from './components/ConnectivityNotice.vue';
import { useAuthStore } from './stores/auth';

const auth = useAuthStore();
const router = useRouter();

async function logout(): Promise<void> {
  await auth.logout();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <a class="skip-link" href="#main-content">Zum Inhalt springen</a>
  <div class="app-shell">
    <header class="site-header">
      <RouterLink class="brand" to="/" aria-label="CaseTogether Startseite">
        <span class="brand-mark" aria-hidden="true">CT</span>
        <span>CaseTogether</span>
      </RouterLink>

      <nav class="main-nav" aria-label="Hauptnavigation">
        <span v-if="auth.status === 'idle' || auth.status === 'loading'" role="status">
          Sitzung wird geprüft …
        </span>
        <template v-else-if="auth.isAuthenticated">
          <span class="user-greeting">Angemeldet als {{ auth.user?.displayName }}</span>
          <button
            class="secondary-button logout-button"
            type="button"
            :disabled="auth.logoutInProgress"
            @click="logout"
          >
            {{ auth.logoutInProgress ? 'Abmeldung …' : 'Abmelden' }}
          </button>
        </template>
        <template v-else>
          <RouterLink to="/login">Anmelden</RouterLink>
          <RouterLink class="nav-cta" to="/register">Konto erstellen</RouterLink>
        </template>
      </nav>
    </header>

    <ConnectivityNotice />

    <main id="main-content" class="main-content" tabindex="-1">
      <RouterView />
    </main>

    <footer class="site-footer">
      <span>CaseTogether</span>
      <span aria-hidden="true">·</span>
      <span>Kooperative Kriminalfälle für 2–4 Spieler</span>
    </footer>
  </div>
</template>
