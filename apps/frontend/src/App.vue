<template>
  <main class="shell">
    <section class="card" aria-labelledby="welcome-title">
      <p class="eyebrow">Kooperative Kriminalfälle</p>
      <h1 id="welcome-title">CaseTogether</h1>
      <p class="lead">Gemeinsam ermitteln. Hinweise teilen. Den Fall lösen.</p>
      <p class="scaffold-note">
        Das technische Monorepo-Grundgerüst ist bereit. Login, private Räume und der erste Fall
        werden in den folgenden Arbeitspaketen umgesetzt.
      </p>
      <ul class="principles" aria-label="Technische Grundlagen">
        <li>Vue 3 und TypeScript strict</li>
        <li>Gemeinsame validierte Verträge</li>
        <li>Keine KI-Konfiguration erforderlich</li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.card {
  width: min(100%, 44rem);
  padding: clamp(2rem, 6vw, 4rem);
  border: 1px solid rgb(216 199 165 / 25%);
  border-radius: 1.5rem;
  background: rgb(25 29 39 / 90%);
  box-shadow: 0 1.5rem 5rem rgb(0 0 0 / 35%);
}

.eyebrow {
  margin: 0 0 0.75rem;
  color: #deb96d;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: clamp(2.75rem, 9vw, 5rem);
  font-weight: 500;
  line-height: 1;
}

.lead {
  margin: 1.5rem 0;
  color: #f3e8cf;
  font-size: clamp(1.05rem, 3vw, 1.3rem);
}

.scaffold-note {
  max-width: 38rem;
  color: #c6cad5;
  line-height: 1.65;
}

.principles {
  display: grid;
  gap: 0.65rem;
  margin: 2rem 0 0;
  padding: 1.25rem 0 0;
  border-top: 1px solid rgb(216 199 165 / 18%);
  list-style: none;
}

.principles li::before {
  margin-right: 0.65rem;
  color: #deb96d;
  content: '◆';
  font-size: 0.65rem;
}
</style>
