<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AuthInput from '../components/AuthInput.vue';
import { authErrorMessage } from '../errors/auth-errors';
import { redirectAfterLogin } from '../router/navigation';
import { useAuthStore } from '../stores/auth';
import { validateLogin, type AuthFieldErrors } from '../validation/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const formElement = ref<HTMLFormElement | null>(null);
const errorSummary = ref<HTMLParagraphElement | null>(null);
const submitting = ref(false);
const serverError = ref('');
const form = reactive({ email: '', password: '' });
const fieldErrors = reactive<AuthFieldErrors>({});
const bootstrapError = computed(() =>
  auth.status === 'error'
    ? 'Die aktuelle Sitzung konnte nicht geprüft werden. Du kannst es später erneut versuchen oder dich jetzt anmelden.'
    : '',
);

function replaceFieldErrors(errors: AuthFieldErrors): void {
  for (const key of ['email', 'password', 'displayName'] as const) {
    delete fieldErrors[key];
    const message = errors[key];
    if (message !== undefined) {
      fieldErrors[key] = message;
    }
  }
}

async function focusError(target: 'form' | 'summary'): Promise<void> {
  await nextTick();
  if (target === 'summary') {
    errorSummary.value?.focus();
    return;
  }
  const invalidInput = formElement.value?.querySelector('[aria-invalid="true"]');
  if (invalidInput instanceof HTMLElement) {
    invalidInput.focus();
  }
}

async function submit(): Promise<void> {
  if (submitting.value) {
    return;
  }

  serverError.value = '';
  const validation = validateLogin(form);
  replaceFieldErrors(validation.errors);
  if (validation.data === null) {
    await focusError('form');
    return;
  }

  submitting.value = true;
  try {
    await auth.login(validation.data);
    form.password = '';
    await router.replace(redirectAfterLogin(route.query['redirect']));
  } catch (error: unknown) {
    serverError.value = authErrorMessage(error, 'login');
    await focusError('summary');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="auth-layout">
    <section class="auth-intro" aria-labelledby="login-intro-title">
      <p class="eyebrow">Gemeinsam ermitteln</p>
      <h2 id="login-intro-title">Der nächste Hinweis wartet schon.</h2>
      <p>Melde dich an und kehre in deine persönliche CaseTogether-Lobby zurück.</p>
      <ul class="trust-list">
        <li>Private, geschützte Gruppenräume</li>
        <li>Keine API-Schlüssel oder KI-Einrichtung im Browser</li>
      </ul>
    </section>

    <section class="auth-card" aria-labelledby="login-title">
      <p class="eyebrow">Willkommen zurück</p>
      <h1 id="login-title">Anmelden</h1>
      <p class="card-intro">Nutze deine Zugangsdaten für CaseTogether.</p>

      <p v-if="auth.serverLogoutUnconfirmed" class="notice" role="status">
        Du wurdest auf diesem Gerät abgemeldet. Der Server konnte die Abmeldung nicht bestätigen.
      </p>
      <p v-if="bootstrapError" class="notice" role="status">{{ bootstrapError }}</p>
      <p v-if="serverError" ref="errorSummary" class="error-summary" role="alert" tabindex="-1">
        {{ serverError }}
      </p>

      <form ref="formElement" novalidate :aria-busy="submitting" @submit.prevent="submit">
        <AuthInput
          id="login-email"
          v-model="form.email"
          label="E-Mail-Adresse"
          type="email"
          inputmode="email"
          autocomplete="email"
          :maxlength="254"
          :error="fieldErrors.email"
        />
        <AuthInput
          id="login-password"
          v-model="form.password"
          label="Passwort"
          type="password"
          autocomplete="current-password"
          :maxlength="128"
          :error="fieldErrors.password"
        />
        <button class="primary-button" type="submit" :disabled="submitting">
          {{ submitting ? 'Anmeldung läuft …' : 'Anmelden' }}
        </button>
      </form>

      <p class="auth-switch">
        Noch kein Konto?
        <RouterLink to="/register">Jetzt registrieren</RouterLink>
      </p>
    </section>
  </div>
</template>
