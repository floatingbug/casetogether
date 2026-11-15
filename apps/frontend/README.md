# CaseTogether Frontend (T004)

Vue-3-SPA mit Composition API, TypeScript strict, Vue Router und Pinia. Enthalten sind das
responsive Grundlayout, Login, Registrierung, eine kleine geschützte Lobby-Ansicht sowie die
Auth-REST-Clients. Räume, Fälle, Chat, Socket.IO und Spielaktionen bleiben bewusst späteren
Tasks vorbehalten.

## Entwicklung

Vom Repository-Stamm:

```bash
pnpm --filter @casetogether/frontend dev
```

Vite leitet `/api` lokal an `http://127.0.0.1:3000` weiter. Der Browser verwendet relative
`/api/v1`-Pfade; es wird keine zusätzliche Frontend-URL- oder Secret-Konfiguration benötigt. Der
Backend-Prozess muss die tatsächliche Frontend-Origin gemäß `docs/DEVELOPMENT.md` erlauben. Der
Proxy verändert keine Origin- oder CSRF-Regeln und ersetzt keine serverseitige Authentifizierung.

## Auth- und Sicherheitsgrenzen

- `src/api/http.ts` und `src/api/auth.ts` validieren Ausgabedaten mit den freigegebenen Shared-Zod-
  Schemas. Request-Bodies werden ebenfalls mit `LoginRequestSchema` beziehungsweise
  `RegisterRequestSchema` validiert und normalisiert.
- Jeder Request verwendet `credentials: 'include'` und `Content-Type: application/json`. Logout
  folgt dem OpenAPI-Vertrag ohne Request-Body und erwartet `204`. Es gibt keine Bearer-Header,
  Session-Tokens in URLs, Local-/Session-Storage, Pinia oder eigenen Frontend-DTOs.
- Erfolgs- (`{ data: ... }`) und Fehlerhüllen (`{ error: ... }`) werden strikt geprüft. Die UI
  wählt verständliche deutsche Texte anhand des Fehlercodes und zeigt keine ungeprüften
  Serverdetails. `INVALID_CREDENTIALS` bleibt generisch; nur die Registrierung bildet
  `EMAIL_ALREADY_REGISTERED` gesondert ab.
- Der Pinia-Store hält ausschließlich das vertragliche `PublicUser` (`id`, `displayName`) und
  nichtprivate UI-Stati. `GET /me` entscheidet beim Bootstrap über den Auth-Status. Fehlende oder
  nicht sichtbare Sitzungen (`UNAUTHENTICATED`/`NOT_FOUND`) räumen private Restdaten.
- Logout versucht zuerst die serverseitige Abmeldung. Lokale Auth-/View-Daten werden anschließend
  **immer** entfernt, auch bei `401`, `404`, `403`, `500` oder Netzwerkfehlern. Falls der Server
  die Abmeldung nicht bestätigt, erscheint auf dem Login ausdrücklich ein Hinweis statt eines
  falschen Server-Erfolgs.
- Geschützte Navigation erfolgt über den Router-Guard. Login-Redirects akzeptieren ausschließlich
  interne Pfade; externe URLs, protokollrelative Ziele, Backslashes und Steuerzeichen werden
  verworfen. Die UI behauptet keine Hostrolle, Raummitgliedschaft, Berechtigung oder Session-Version.
- Inhalte werden über normale Vue-Textinterpolation ausgegeben. Es gibt kein `v-html`, keine
  Provider-/Backend-Secrets und keine serverseitigen Falltypen im Frontend.
- Ladezustände verhindern doppelte Form- und Logout-Absendungen. `ConnectivityNotice` meldet
  Offline-/Reconnect-Ereignisse; API-Ausfälle erhalten einen separaten, nicht sensitiven Fehlertext.

## Tests und ausdrückliche Integrationsgrenze

Unit- und Component-Tests verwenden ausschließlich vertragstreue `fetch`-Doppel mit denselben
JSON-/Status-/Fehlerformaten wie OpenAPI und die Shared-Zod-Schemas. Playwright startet echte
Chromium-Browser und Vite, fängt aber `/me`, `/auth/login`, `/auth/logout` und `/auth/register`
per Route-Interception ab. Damit werden Desktop und ein mobiles Viewport, geschützte Redirects,
Login, Registrierung, Logout, CSRF- und `NOT_FOUND`-Fälle sowie leerer Browser-Storage geprüft.

**T003 ist in diesem Worktree nicht integriert.** Diese Tests starten weder Backend noch MongoDB
und belegen keine produktive Cookie-, Session-, Passwort-Hashing- oder Datenbankintegration. Die
Authentifizierung beim Server bleibt Autorität und muss nach der Integration separat getestet
werden. Es finden keine Live-LLM-Aufrufe statt.

```bash
# Vitest: Unit- und Component-Tests, kein Playwright
pnpm --filter @casetogether/frontend test

# Einmalig beziehungsweise nach Browserpaket-Updates
pnpm --filter @casetogether/frontend exec playwright install chromium

# Echte Browser-Smokes; baut zuerst Shared und startet Vite automatisch
pnpm --filter @casetogether/frontend test:e2e
```

Root-`pnpm test` bleibt der reine Vitest-/Unit-/Component-Lauf. Der eigene `test:e2e`-Schritt und
die lokale Chromium-Installation sind im CI-Workflow getrennt hinterlegt; kein externer Service
wird dafür verwendet.

## Isolierter Playwright-Testserver

Playwright verwendet ausschließlich den dedizierten Testport **5175** (`http://127.0.0.1:5175`).
Dieselbe Konstante in `playwright.config.ts` steuert `baseURL`, das Vite-Kommando und
`webServer.url`. Es wird **keine** Produkt- oder Deployment-Umgebungsvariable eingeführt.

`reuseExistingServer` ist ausdrücklich und unabhängig von CI dauerhaft `false`. Playwright darf
daher keinen bereits vorhandenen Server wiederverwenden – weder aus dem eigenen Worktree noch aus
dem kanonischen Checkout beziehungsweise einem anderen Task oder einer anderen Anwendung. Vite
startet mit `--strictPort`: Ist 5175 bereits belegt, bricht der Start mit einem verständlichen
Portfehler ab; es gibt keinen Fallback auf einen fremden Server oder eine andere URL.

Beim Testlauf startet Playwright ausschließlich den Vite-Prozess des T004-Worktrees auf 5175 und
beendet die von ihm gestarteten Testprozesse nach dem Lauf wieder. Andere laufende Server – auch
auf dem regulären Frontend-Port 5173 – werden weder verwendet, verändert noch beendet. Die Isolation gegenüber fremden Test- und Produktservern wird dadurch technisch verhindert, nicht
nur durch eine Portkonvention gesichert.
