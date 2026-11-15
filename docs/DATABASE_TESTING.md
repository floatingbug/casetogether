# T003 – Reale Testdatenbankstrategie

## Zweck und Isolation

Die MongoDB-Integrationstests unter `apps/backend/test` verwenden einen realen lokalen
`mongod`-Prozess. Ein In-Memory-Repository oder lediglich gemockte Treiberaufrufe gelten nicht als
Ersatz. Sie benötigen ausschließlich synthetische User-/Session-Fixture-Daten und verwenden niemals
eine produktive Datenbank, MongoDB Atlas, einen persistierten externen Cluster oder Live-LLMs.

Die Tests starten nur Standalone-Instanzen auf `127.0.0.1` mit einem freien Ephemeral-Port. Die URI
hat die Form `mongodb://127.0.0.1:<freier-port>/casetogether_t003_test`. Nach dem Start belegt ein
offizieller MongoDB-Client per `buildInfo` die tatsächlich laufende Binaryversion; Readiness wird
durch echte `{ ping: 1 }`-Kommandos geprüft.

## Fixierte Libraries und Binary

| Komponente                   | Version / Konfiguration                                     |
| ---------------------------- | ----------------------------------------------------------- |
| MongoDB Node.js-Treiber      | `mongodb@7.9.0`                                             |
| Testprozess-Manager          | `mongodb-memory-server-core@11.3.0`                         |
| `mongod`                     | `7.0.24`, standalone, Speicher-Engine gemäß Library-Default |
| Native Passwortbibliothek    | `@node-rs/argon2@2.2.2`                                     |
| Cookie-Parser/Serialisierung | `cookie@2.0.2`                                              |

Bewusst wird `mongodb-memory-server-core` und nicht das Wrapperpaket mit Postinstall-Download
verwendet. Dadurch bleibt die zentral freigegebene Build-Skriptliste unverändert. Der Download
erfolgt erst explizit beim Start der Testinstanz.

- Download-/Entpackcache: `/tmp/opencode/casetogether-mongodb-binaries`
- Pro Suite frisches Datenverzeichnis: `/tmp/opencode/casetogether-t003-db-*/mongod-data`
- Kein DB-Verzeichnis im Repository und keine Testdaten im pnpm-Store.
- Der erste Start ohne Cache lädt die für den Host gewählte MongoDB-Distribution. Danach wird der
  Cache wiederverwendet. Ein initialer Download benötigt Netzwerk zu den offiziellen MongoDB-
  Downloadservern; ein bereits befüllter Cache benötigt keinen externen DB-Dienst.

Am 15.11.2026 wurde die reale Verfügbarkeit auf dem CachyOS-x86_64-Host nachgewiesen. Da es
keinen offiziellen Arch-/CachyOS-Build gibt, meldete die Bibliothek den Fallback auf den
Ubuntu-22.04-Build. Der Download umfasste 81,8 MiB; Start, Treiberverbindung und `buildInfo`
lieferten tatsächlich `7.0.24`, gefolgt von kontrolliertem Stop und Verzeichnis-Cleanup. Diese
Host-Eigenschaft ist keine Zusicherung für andere Plattformen.

## Start, Fixtures und Teardown

`apps/backend/test/support/mongo-test-database.ts` kapselt den Lebenszyklus:

1. Eindeutiges temporäres Elternverzeichnis unter `/tmp/opencode` erzeugen.
2. `MongoMemoryServer.create` mit fixierter Version, Cachepfad, Loopback und Starttimeout von 60 s
   aufrufen; Port vergibt die Library dynamisch.
3. Offiziellen Client mit der konkreten Test-URI verbinden; `buildInfo` ausführen.
4. Pro Test lediglich `users` und `authSessions` leeren. Indizes werden durch den echten
   Composition-Pfad beziehungsweise idempotent durch `ensureAuthIndexes` erstellt.
5. Nach der Suite zuerst alle zusätzlich erzeugten MongoClients schließen, danach
   `mongod.stop({ doCleanup: true, force: true })`, anschließend das temporäre Verzeichnis
   rekursiv entfernen. Startfehler durchlaufen dieselbe Cleanup-Sequenz. Der zentrale Client wird
   vor dem Testinstanz-Stop geschlossen.

Vitest läuft im Backend mit einem einzigen Fork (`singleFork`). Dadurch starten die drei
Integrationssuites deterministisch nacheinander und teilen weder DB-Verzeichnis noch Rate-Limit-
oder Clock-Zustand. Innerhalb einer Suite ist jeder Fixture-Cleanup explizit. Der echte HTTP-Smoke
schließt zusätzlich seinen lauschenden Server und die separate Readiness-Verbindung im `finally`.

Bei fehlendem Binary, verweigertem Download, inkompatiblen Systembibliotheken oder Startfehler darf
kein Test als „Integration erfolgreich“ dokumentiert werden. Die Suite muss sichtbar fehlschlagen;
es gibt keinen Mock-Fallback und kein Skip, das ein erfolgreiches DB-Kriterium vortäuscht.

## Nachweismatrix

- `mongodb.integration.test.ts`: tatsächliche `mongod`-Version/Loopback-URI, idempotente Unique-/TTL-
  Indizes, keine fremden Fall-/Spielcollections, realer `11000` bei normalisierter E-Mail-
  Duplikation, Rohdokumentprüfung ohne Klartext-Session-ID/Signatur/Passwort sowie Readiness `200`
  bei echtem Ping und `503` nach `client.close()` bei unverändert lokaler Liveness.
- `auth.integration.test.ts`: Registrierung einschließlich race-bedingtem Unique-Fehler, Normalisie-
  rung/Unicode/Locale, Duplicate-/Validation-Hüllen, generischer Loginfehler, Login und Rehash,
  `/me`, HMAC-/Unknown-Session-Ablehnung, Logout plus DB-Revocation, gelöschtes Cookie, exakte
  Ablaufgrenze mit injizierbarer Uhr, produktive `Secure`-Attribute, Origin/Fetch-/JSON-/Payload-
  Schutz, IP-/Konto-Limits mit Retry-Feldern und interne Fehler-/Logbereinigung.
- `runtime.integration.test.ts`: real lauschender HTTP-Port mit Node-`fetch`, echte Ready-/Health-
  Responses und vollständiger Cookie-Transport für Registrierung → `/me` → Logout → `/me` 401.
- `test/support/built-main-smoke.mjs`: startet zusätzlich den tatsächlich gebauten
  `dist/src/main.js`-Entry-Point mit einem eigenen temporären `mongod`, prüft dieselben HTTP-
  Statusfolgen sowie normalisierte E-Mail-Persistenz und beendet den Backendprozess mit Exitcode 0.
  Roh-Stdout/-Stderr des Kindprozesses wird nicht in Logs ausgegeben; das Ergebnis enthält nur
  Statuscodes und die unverfängliche Binaryversion.
- `password-hasher.test.ts`, `session-tokens.test.ts`, `rate-limiter.test.ts`, `config.test.ts`:
  schnelle Unit-Nachweise für PHC-Parameter/Salts, CSPRNG/HMAC/Hash-Projektion, deterministische
  Fenster und Pending-Parallelität sowie zwingende Runtimekonfiguration ohne Secret-Leaks. Die
  Konto-/IP-Uhr wird nur verändert; es gibt keine Wartezeiten von Minuten oder Tagen.
- Bestehende `health.test.ts`- und `security.test.ts`-Dateien sichern die T002-Baseline.

Datenbankrohdokumente werden ausschließlich in diesen temporären Testinstanzen gelesen. Runtime-Logs
und öffentliche DTO-/Error-Bodies werden zusätzlich gegen Testpasswort, Cookie/Session-ID,
`SESSION_SECRET` und E-Mail-Klartext geprüft. Die zentrale Shared-Grenze bleibt unverändert.

## Ausführung

```bash
pnpm install --frozen-lockfile
pnpm --filter @casetogether/backend test
```

Für eine gezielte Sicht auf offene Handles und den beendeten Prozess ist der reguläre `vitest run`-
Exit maßgeblich; Watch-Modus ist kein Nachweis. Nachabschluss muss kein Test-`mongod` mehr laufen.

Nach einem erfolgreichen Build ist auch der eigenständige Runtime-Start reproduzierbar:

```bash
pnpm build
node apps/backend/test/support/built-main-smoke.mjs
```

Der Smoke gibt ausschließlich eine zusammenfassende JSON-Zeile aus. Er beendet HTTP-Server,
MongoClient und `mongod` auch im Fehlerfall und entfernt sein eigenes temporäres DB-Verzeichnis.
