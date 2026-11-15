<script setup lang="ts">
import { nextTick, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AuthInput from '../components/AuthInput.vue';
import { authErrorMessage } from '../errors/auth-errors';
import { redirectAfterLogin } from '../router/navigation';
import { useAuthStore } from '../stores/auth';
import { validateRegister, type AuthFieldErrors } from '../validation/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const formElement = ref<HTMLFormElement | null>(null);
const errorSummary = ref<HTMLParagraphElement | null>(null);
const submitting = ref(false);
const serverError = ref('');
const form = reactive({ displayName: '', email: '', password: '' });
const fieldErrors = reactive<AuthFieldErrors>({});

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
  const validation = validateRegister(form);
  replaceFieldErrors(validation.errors);
  if (validation.data === null) {
    await focusError('form');
    return;
  }

  submitting.value = true;
  try {
    await auth.register(validation.data);
    form.password = '';
    await router.replace(redirectAfterLogin(route.query['redirect']));
  } catch (error: unknown) {
    serverError.value = authErrorMessage(error, 'register');
    await focusError('summary');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="auth-layout">
    <section class="auth-intro" aria-labelledby="register-intro-title">
      <p class="eyebrow">Dein Ermittlerteam</p>
      <h2 id="register-intro-title">Ein Konto. Gemeinsame Fälle.</h2>
      <p>Erstelle dein Konto und öffne deine persönliche Lobby für kommende Ermittlungen.</p>
      <p class="privacy-note">
        Die Lobby zeigt deinen Anzeigenamen. Sessiondaten werden nicht in Local- oder
        Session-Storage abgelegt.
      </p>
    </section>

    <section class="auth-card" aria-labelledby="register-title">
      <p class="eyebrow">Neu bei CaseTogether</p>
      <h1 id="register-title">Konto erstellen</h1>
      <p class="card-intro">Alle Felder sind erforderlich.</p>

      <p v-if="serverError" ref="errorSummary" class="error-summary" role="alert" tabindex="-1">
        {{ serverError }}
      </p>

      <form ref="formElement" novalidate :aria-busy="submitting" @submit.prevent="submit">
        <AuthInput
          id="register-display-name"
          v-model="form.displayName"
          label="Anzeigename"
          autocomplete="nickname"
          hint="1–32 Zeichen; so sehen dich deine Mitspieler."
          :maxlength="32"
          :error="fieldErrors.displayName"
        />
        <AuthInput
          id="register-email"
          v-model="form.email"
          label="E-Mail-Adresse"
          type="email"
          inputmode="email"
          autocomplete="email"
          :maxlength="254"
          :error="fieldErrors.email"
        />
        <AuthInput
          id="register-password"
          v-model="form.password"
          label="Passwort"
          type="password"
          autocomplete="new-password"
          hint="12–128 Zeichen; keine bestimmten Zeichenklassen erforderlich."
          :maxlength="128"
          :error="fieldErrors.password"
        />
        <button class="primary-button" type="submit" :disabled="submitting">
          {{ submitting ? 'Konto wird erstellt …' : 'Konto erstellen' }}
        </button>
      </form>

      <p class="auth-switch">
        Bereits registriert?
        <RouterLink to="/login">Zur Anmeldung</RouterLink>
      </p>
    </section>
  </div>
</template>
