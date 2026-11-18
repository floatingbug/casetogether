# Lokale Entwicklung und Verifikation

Dieses Kapitel beschreibt das T002-Grundgerüst. Die fachlichen Regeln bleiben ausschließlich in
`contracts/`, `specs/`, der Architektur und den ADRs maßgeblich. Bereitstellung und
Vercel-Konfiguration sind in `docs/DEPLOYMENT.md` beschrieben.

## Voraussetzungen

- Node.js aus `.nvmrc` (aktuell `22.23.5`; erlaubt ist Node 22)
- pnpm aus `package.json#packageManager` (aktuell `12.19.0`)
- Für die System-Endpunkte und Tests **keine** MongoDB und **keine** KI-Konfiguration

Ein passendes pnpm kann nach Rücksprache mit der lokalen Node-Verwaltung beispielsweise über
`npm install --global pnpm@12.19.0` bereitgestellt werden. Das Repository installiert keine
globalen Werkzeuge automatisch.

## Installation

Nach dem ersten Erzeugen des Lockfiles beziehungsweise bei einem vorhandenen Lockfile:

```bash
pnpm install --frozen-lockfile
```

Versionen sind in den Manifesten exakt fixiert und zusätzlich in `pnpm-lock.yaml` aufgelöst.
`.npmrc` erzwingt kompatible Node-Versionen und speichert exakte Versionen. pnpm 12 erlaubt das
Lifecycle-Installationsprogramm ausschließlich für das für Vite/Vitest benötigte `esbuild` über
`allowBuilds` in `pnpm-workspace.yaml`.

Für eine Offline-Prüfung mit bereits befülltem lokalem pnpm-Store:

```bash
pnpm install --frozen-lockfile --offline --force
```

`--force` wiederholt die Installation, statt nur die vorhandenen `node_modules` als aktuell zu
erkennen. Ein komplett neuer Rechner ohne befüllten Store muss Abhängigkeiten zunächst aus der
Registry beziehen; ein Lockfile allein enthält keine Paketarchive. Der tatsächlich ausgeführte
Offline-Nachweis für diesen Task steht in `tasks/T002.md`.

## Entwicklung starten

Beide Anwendungen gemeinsam starten:

```bash
pnpm dev
```

Alternativ getrennt:

```bash
pnpm --filter @casetogether/backend dev
pnpm --filter @casetogether/frontend dev
```

Standard URLs auf der lokalen Loopback-Schnittstelle:

- Backend: `http://127.0.0.1:3000`
- Frontend: `http://127.0.0.1:5173`

Für einen anderen Backend-Testport:

```bash
PORT=3001 pnpm --filter @casetogether/backend dev
```

Für einen anderen Vite-Port:

```bash
pnpm --filter @casetogether/frontend exec vite --host 127.0.0.1 --port 5174 --strictPort
```

`FRONTEND_ORIGIN` muss bei einem nicht standardmäßigen Browser-Origin exakt zum Frontend passen.
Mehrere exakte Origins können kommasepariert gesetzt werden. Der Wert ist eine Origin ohne
abschließenden Slash oder Pfad, niemals `*`.

## System-Endpunkte und bewusste T002-Grenze

```bash
curl --include http://127.0.0.1:3000/api/v1/health
curl --include http://127.0.0.1:3000/api/v1/ready
```

Erwartete Liveness, unabhängig von MongoDB und Provider:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{"data":{"status":"ok"}}
```

Bis T003 eine echte MongoDB-Verbindung injiziert, lautet Readiness ehrlich:

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json; charset=utf-8

{"data":{"status":"not_ready","checks":{"mongodb":"down"}}}
```

Das ist kein simulierter Datenbank-Erfolg: Das Gerüst eröffnet keine Verbindung und behauptet keine
Bereitschaft. Liveness ruft den MongoDB-Status nicht auf. Weder Start noch Health oder Readiness
lesen `OPENAI_API_KEY` oder `OPENAI_MODEL`; es existiert in T002 kein Provider-Adapter und daher
kein Provideraufrufpfad. Die spätere Aktivierung von T003 darf nur den notwendigen MongoDB-Status
injizieren, niemals einen Provider als Readiness-Bedingung ergänzen.

## Konfiguration und Secrets

`.env.example` enthält ausschließlich dokumentierte Platzhalter und leere optionale KI-Werte.
Lokale echte Werte gehören in eine ignorierte `.env`, niemals in Git, Tests, Logs oder das
Frontend-Bundle. Das T002-Backend verarbeitet JSON-Anwendungspayloads bis höchstens 16 KiB,
verwendet Credential-CORS nur mit exakt zugelassenen Origins und setzt restriktive Security-Header.

Das Objekt `readBackendConfig().authCookie` hält die ADR-002-Basis für T003 bereit: `ct_session`,
HttpOnly, `SameSite=Lax`, `Path=/` und `Secure` ausschließlich in Produktion. T002 setzt selbst
**keinen** Cookie und implementiert keine Session, kein Secret und keine Authentifizierung. Die
Origin-/Fetch-Metadata-/JSON-Grundprüfung unsicherer Methoden ersetzt später keine
Session-/Use-Case-Autorisierung.

## Qualitätsgates

Alle relevanten Workspaces werden von Root-Befehlen erreicht:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm contracts:check
pnpm format:check
pnpm build
```

- `lint`: ESLint einschließlich TypeScript- und Vue-Regeln; explizites `any` wird abgelehnt.
- `typecheck`: `tsc`/`vue-tsc` mit strict, `exactOptionalPropertyTypes` und
  `noUncheckedIndexedAccess`.
- `test`: Vitest, Supertest und Vue Test Utils; keine Datenbank oder externen Dienste.
- `contracts:check`: parst OpenAPI 3.1 lokal, prüft lokale Referenzen, eindeutige Operation-IDs,
  Pflichtoperationen, Cookie-Auth und Pfadparameter ohne externe API.
- `format:check`: Prettier für Gerüst-, Workspace-, CI-, Skript- und Task-Dateien.
- `build`: Shared zuerst, danach Backend und Frontend. Der Standard-Export des Shared-Pakets nutzt
  danach kompilierte ESM-Dateien; lokale Tools wählen die `development`-Bedingung auf die Quellen.

Weiterführende Einzelbefehle:

```bash
pnpm --filter @casetogether/shared test
pnpm --filter @casetogether/backend test
pnpm --filter @casetogether/frontend test
```

## Nicht Bestandteil dieses Gerüsts

Auth-Sessions und -Persistenz (T003), Login-/Routing-/API-Client-UI (T004), Räume und reale
Repositories (T003/T005), Socket.IO (T006), deterministische Engine und Fallinhalt (T007),
optionale KI (T008), durchgängiger Spielablauf (T009) und Betrieb/Deployment (T011) sind nicht
Bestandteil dieses Gerüsts; Bereitstellung und Vercel-Konfiguration beschreibt
`docs/DEPLOYMENT.md`. Es gibt keine Deployment-Schritte in CI.
