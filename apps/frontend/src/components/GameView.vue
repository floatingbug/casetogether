<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AnswerSource, SuspectId } from '@casetogether/shared';
import { useGameStore } from '../stores/game';
import { useAuthStore } from '../stores/auth';
import ChatPanel from './ChatPanel.vue';
import GameStatusMessages from './GameStatusMessages.vue';
import MemberList from './MemberList.vue';

const game = useGameStore();
const auth = useAuthStore();
const selectedSuspectId = ref<SuspectId | null>(null);
const finalSuspectId = ref<SuspectId | null>(null);

watch(
  () => game.game?.suspects,
  (suspects) => {
    const first = suspects?.[0];
    if (
      suspects !== undefined &&
      first !== undefined &&
      (selectedSuspectId.value === null ||
        !suspects.some((item) => item.id === selectedSuspectId.value))
    ) {
      selectedSuspectId.value = first.id;
    }
  },
  { immediate: true },
);

const selectedSuspect = computed(() =>
  game.game?.suspects.find((suspect) => suspect.id === selectedSuspectId.value),
);
const questions = computed(() =>
  (game.game?.availableQuestions ?? []).filter(
    (question) => question.suspectId === selectedSuspectId.value,
  ),
);
const dialogues = computed(() =>
  (game.game?.dialogues ?? []).filter((dialogue) => dialogue.suspectId === selectedSuspectId.value),
);
const pendingHere = computed(
  () => game.pendingQuestion?.request.suspectId === selectedSuspectId.value,
);
const canInvestigate = computed(
  () => game.game?.phase === 'investigating' && game.connectionStatus === 'connected',
);

function sourceLabel(source: AnswerSource): string {
  switch (source) {
    case 'reference':
      return 'Katalog-Referenzantwort';
    case 'ai':
      return 'KI-formulierte Darstellung';
    case 'fallback':
      return 'Referenzantwort nach optionalem KI-Fallback';
  }
}

function localTime(value: string): string {
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

async function submitFinal(): Promise<void> {
  if (finalSuspectId.value !== null && canInvestigate.value) {
    await game.submitFinal(finalSuspectId.value);
  }
}
</script>

<template>
  <div v-if="game.game" class="game-view">
    <GameStatusMessages />

    <section class="case-status panel" aria-labelledby="case-status-heading">
      <div>
        <p class="eyebrow">Fall {{ game.game.caseId }} · Version {{ game.game.caseVersion }}</p>
        <h2 id="case-status-heading">
          {{
            game.game.phase === 'investigating'
              ? 'Ermittlung läuft'
              : game.game.phase === 'completed'
                ? 'Fall abgeschlossen'
                : 'Ermittlung beendet'
          }}
        </h2>
        <p v-if="game.game.phase === 'investigating'">
          Alle sichtbaren Fragen und Antworten stammen aus deiner autorisierten Serveransicht.
          Freitext ist nicht erforderlich.
        </p>
        <p v-else-if="game.game.phase === 'abandoned'">
          Der Server hat diese Sitzung beendet. Es wird keine Auflösung erzeugt.
        </p>
      </div>
      <span class="version-badge" aria-label="Bestätigte Spielversion"
        >Stand {{ game.game.version }}</span
      >
    </section>

    <div class="game-grid">
      <div class="game-main-column">
        <section class="panel suspects-panel" aria-labelledby="suspects-heading">
          <p class="eyebrow">Katalogbefragung</p>
          <h2 id="suspects-heading">Verdächtige</h2>
          <div class="suspect-selector" role="group" aria-label="Verdächtigen auswählen">
            <button
              v-for="suspect in game.game.suspects"
              :key="suspect.id"
              class="suspect-button"
              type="button"
              :aria-pressed="selectedSuspectId === suspect.id"
              @click="selectedSuspectId = suspect.id"
            >
              <strong>{{ suspect.displayName }}</strong>
              <span>{{ suspect.publicDescription }}</span>
            </button>
          </div>
        </section>

        <section
          v-if="selectedSuspect"
          class="panel questioning-panel"
          aria-labelledby="questions-heading"
        >
          <div class="panel-heading-row">
            <div>
              <p class="eyebrow">{{ selectedSuspect.displayName }}</p>
              <h2 id="questions-heading">Verfügbare Fragen</h2>
            </div>
            <span class="count-badge">{{ questions.length }}</span>
          </div>
          <p class="field-hint">
            Wähle eine konkrete Katalogfrage. Antworten und Hinweise werden erst nach Servererfolg
            angezeigt.
          </p>
          <div v-if="game.game.phase !== 'investigating'" class="empty-inline">
            Die Ermittlung ist beendet; neue Fragen sind nicht möglich.
          </div>
          <div v-else-if="questions.length === 0" class="empty-inline">
            Für diese Person sind aktuell keine weiteren Fragen freigeschaltet. Prüfe andere
            Verdächtige oder deine bereits erhaltenen Hinweise.
          </div>
          <div v-else class="question-list">
            <button
              v-for="question in questions"
              :key="question.questionId"
              class="question-button"
              type="button"
              :disabled="
                !canInvestigate ||
                game.askingQuestion ||
                game.pendingQuestion !== null ||
                game.submittingFinal
              "
              @click="game.askCatalog(question)"
            >
              {{ question.text }}
            </button>
          </div>

          <div v-if="pendingHere && game.pendingQuestion" class="pending-card" role="status">
            <strong>Frage gesendet – Antwort noch nicht bestätigt</strong>
            <p>{{ game.pendingQuestion.questionText }}</p>
            <p>Es werden noch keine Antwort, keine Hinweise und keine neue Version angenommen.</p>
            <button
              class="secondary-button compact-button"
              type="button"
              :disabled="!canInvestigate || game.askingQuestion"
              @click="game.retryCatalogQuestion"
            >
              {{
                game.askingQuestion
                  ? 'Ausgang wird geprüft …'
                  : 'Mit gleicher Anfrage erneut prüfen'
              }}
            </button>
          </div>
        </section>

        <section class="panel dialogue-panel" aria-labelledby="dialogue-heading">
          <p class="eyebrow">Nur autorisierte Serverprojektion</p>
          <h2 id="dialogue-heading">Dialoge mit {{ selectedSuspect?.displayName }}</h2>
          <p v-if="dialogues.length === 0" class="empty-inline">
            Noch keine bestätigten Dialoge mit dieser Person in deiner Ansicht.
          </p>
          <ol v-else class="dialogue-list" aria-live="polite">
            <li v-for="dialogue in dialogues" :key="dialogue.id" class="dialogue-entry">
              <div class="chat-meta">
                <strong
                  >{{ dialogue.askedBy.displayName
                  }}<span v-if="dialogue.askedBy.id === auth.user?.id"> (du)</span></strong
                >
                <time :datetime="dialogue.createdAt">{{ localTime(dialogue.createdAt) }}</time>
              </div>
              <p class="question-text"><strong>Frage:</strong> {{ dialogue.questionText }}</p>
              <p class="answer-text"><strong>Antwort:</strong> {{ dialogue.answerText }}</p>
              <p class="field-hint">
                {{ sourceLabel(dialogue.answerSource) }} ·
                {{ dialogue.mode === 'catalog' ? 'Katalog' : 'Optionaler Freitext' }}
              </p>
            </li>
          </ol>
        </section>
      </div>

      <aside class="game-side-column" aria-label="Team und Hinweise">
        <MemberList />
        <section class="panel clues-panel" aria-labelledby="public-clues-heading">
          <p class="eyebrow">Raumöffentlich</p>
          <h2 id="public-clues-heading">Gemeinsame Hinweise</h2>
          <p v-if="game.game.publicClues.length === 0" class="empty-inline">
            Noch keine gemeinsamen Hinweise.
          </p>
          <ol v-else class="clue-list">
            <li v-for="clue in game.game.publicClues" :key="clue.id">
              <strong>{{ clue.title }}</strong>
              <p>{{ clue.text }}</p>
            </li>
          </ol>
        </section>
        <section class="panel clues-panel private-clues" aria-labelledby="private-clues-heading">
          <p class="eyebrow">Nur für dich</p>
          <h2 id="private-clues-heading">Deine privaten Hinweise</h2>
          <p class="field-hint">
            Diese Liste stammt ausschließlich aus deiner eigenen Serverprojektion.
          </p>
          <p v-if="game.game.privateClues.length === 0" class="empty-inline">
            Du hast noch keine privaten Hinweise.
          </p>
          <ol v-else class="clue-list">
            <li v-for="clue in game.game.privateClues" :key="clue.id">
              <strong>{{ clue.title }}</strong>
              <p>{{ clue.text }}</p>
            </li>
          </ol>
        </section>
        <ChatPanel />
      </aside>
    </div>

    <section
      v-if="game.game.phase === 'investigating'"
      class="panel final-panel"
      aria-labelledby="final-heading"
    >
      <p class="eyebrow">Gemeinsame Entscheidung</p>
      <h2 id="final-heading">Finale Abgabe</h2>
      <p>
        Ein Mitglied kann die abgestimmte Gruppenlösung einmalig abgeben. Der Server sperrt,
        bewertet und schließt atomar ab. Die UI berechnet weder Täter noch Punkte.
      </p>
      <form @submit.prevent="submitFinal">
        <fieldset
          class="final-suspects"
          :disabled="game.submittingFinal || game.pendingFinal !== null"
        >
          <legend>Wen nennt ihr als Täter?</legend>
          <label v-for="suspect in game.game.suspects" :key="suspect.id">
            <input v-model="finalSuspectId" type="radio" name="final-suspect" :value="suspect.id" />
            {{ suspect.displayName }}
          </label>
        </fieldset>
        <p v-if="game.pendingFinal" class="pending-card" role="status">
          Finale Abgabe unbestätigt. Es gibt noch kein Ergebnis und keine Auflösung. Ein erneuter
          Versuch verwendet exakt dieselbe Anfrage und Version.
        </p>
        <button
          class="primary-button"
          type="submit"
          :disabled="
            finalSuspectId === null ||
            !canInvestigate ||
            game.submittingFinal ||
            game.askingQuestion
          "
        >
          {{
            game.submittingFinal
              ? 'Server bestätigt Ergebnis …'
              : 'Gemeinsame Lösung verbindlich abgeben'
          }}
        </button>
      </form>
    </section>

    <section
      v-else-if="game.game.phase === 'completed' && game.game.result"
      class="panel resolution-panel"
      aria-labelledby="resolution-heading"
      aria-live="polite"
    >
      <p class="eyebrow">Vom Server bestätigt</p>
      <h2 id="resolution-heading">{{ game.game.result.resolution.title }}</h2>
      <p class="verdict">
        {{
          game.game.result.verdict === 'correct'
            ? 'Richtige Gruppenlösung'
            : 'Die Gruppenlösung war nicht richtig'
        }}
        · {{ game.game.result.awardedPoints }}/{{ game.game.result.maximumPoints }} Punkte
      </p>
      <p>{{ game.game.result.feedback }}</p>
      <h3>Auflösung</h3>
      <p>{{ game.game.result.resolution.explanation }}</p>
      <p v-if="game.game.finishedAt" class="field-hint">
        Abgeschlossen am {{ localTime(game.game.finishedAt) }}.
      </p>
    </section>
  </div>
</template>
