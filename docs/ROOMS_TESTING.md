# T005 – Reale Testdatenbankstrategie für Spielräume

## Umfang und Isolation

Die Rooms-Integrationstests verwenden denselben realen Testdatenbankpfad wie T003:
`apps/backend/test/support/mongo-test-database.ts` startet **mongodb-memory-server-core 11.3.0** mit
**mongod 7.0.24** auf `127.0.0.1` und einem freien Ephemeral-Port. Der offizielle `mongodb@7.9.0`-
Client führt nach dem Start `buildInfo` aus. Es gibt weder ein Repository-Mock noch einen Fallback auf
externe Infrastruktur. Keine Suite benötigt eine produktive MongoDB, Atlas, Live-LLMs oder echte Secrets.

- Binary-/Entpackcache: `casetogether-mongodb-binaries` im System-Temp-Verzeichnis (`os.tmpdir()`)
- Pro Suite frisches Datenverzeichnis: `casetogether-t003-db-*/mongod-data` im System-Temp-Verzeichnis
- Rooms-Suiten starten jeweils eine eigene Standalone-Instanz in `beforeAll` und stoppen sie in
  `afterAll` mit `stop({ doCleanup: true, force: true })`.
- Der zentrale MongoClient wird vor dem `mongod`-Stop geschlossen; anschließend wird das temporäre
  Verzeichnis rekursiv entfernt. Auch der Starter selbst räumt Startfehler nach derselben Sequenz auf.
- Vitest nutzt im Backend weiterhin `singleFork`; dadurch laufen die Suiten deterministisch nacheinander.

Zusätzlich zur T003-Fixture leert `resetRoomsTestDatabase` vor jedem Rooms-Test `users`, `authSessions`
und `rooms`. `createRoomsTestApp` instanziiert pro Test den echten `IdentityService` und `RoomService`
über `createIdentityService`/`createRoomService`; letzterer ruft idempotent `ensureRoomIndexes` auf. Die
Auth-Cookies stammen aus echten HTTP-Registrierungen, nicht aus Fixture-Tokens oder Mock-Sessions.

## Deterministische Zeit, Codes und Neustarts

`MutableClock` bestimmt exakt die 60-Minuten-Einladungs- und 24-Stunden-Lobbygrenzen. Kein Test wartet
real Minuten oder Stunden. Fixes starten bei `2026-11-15T12:00:00.000Z`. Erstellungs-, Update- und Ablaufzeitpunkte werden als echte MongoDB-`Date`-Werte geprüft; der fachliche
Ablauf wird ohne einen
TTL-Timerlauf bewiesen. Der asynchrone TTL-Index ist jederzeit aktiv, zur Ablehnung aber nicht nötig.

Produktive Einladungen verwenden CSPRNG. Für reproduzierbare Unique-Kollisionen injizieren einzelne
Tests einen Generator mit synthetischen, klar als Testwerte erkennbaren Codes. Das ersetzt keine
Produktionslogik: Der Test durchläuft weiterhin den echten Unique-Index und die echten Updates.
Separate Tests prüfen die Standarderzeugung gegen Alphabet, Länge und Gruppierung.

Neustart-Verluste werden auf zwei Ebenen getestet:

1. Supertest-Suiten erzeugen Identity/RoomService und App mit derselben DB neu. Gespeicherte Cookies
   und Receipts überleben, flüchtiger Servicezustand nicht. Create-/Rotate-Replays müssen codefrei sein;
   ein anschließend injizierter Codegenerator beweist, dass der Replay keinen neuen Code verbraucht.
2. `built-rooms-main-smoke.mjs` startet den tatsächlich gebauten `dist/src/main.js` zweimal gegen denselben
   temporären `mongod`. Dazwischen wird der Node-Prozess mit `SIGTERM` beendet. Der Smoke führt mit echten
   Cookies Create, Join, Get und Host-Rotate aus und wiederholt Create/Rotate nach dem Neustart.

## Behobener Rotate-/Replay-Race (T012)

Der Test `rooms.integration.test.ts › resolves concurrent identical rotations as one rotated secret
and one replay` konnte scheduleabhängig `200 rotated` + `409 VERSION_CONFLICT` statt
`200/200 rotated/replayed` liefern. Ursache war ein TOCTOU im `RoomService.rotateInvitation`-Ablauf:

- Beide identischen Requests lasen den Receipt, bevor einer committete (`room-service.ts:349-358`).
- Der Gewinner committete Version 2 + `rotate`-Receipt.
- Der Verlierer las den Raum erst danach, sah Version 2 und scheiterte im Service-Vorabcheck an
  `assertRotateAllowed` mit `VERSION_CONFLICT`, bevor er den Repository-CAS oder den
  Nach-CAS-Replay-Fallback erreichte.

**Fix (2026-11-19):** `rotateInvitation` und `leaveRoom` prüfen nach einem `ApplicationError` aus
Raumread/Assert den exakten Receipt erneut (`readSecretReplay` bzw. `readLeaveReplay`). Ein Treffer
liefert den codefreien Replay ohne Publikation; ohne Treffer bleibt der ursprüngliche Fehler
(`FORBIDDEN`, `NOT_FOUND`, `VERSION_CONFLICT`, `ROOM_CLOSED`, `INVALID_STATE_TRANSITION`). Gleicher
Key mit anderem Payload-Hash ergibt weiterhin `IDEMPOTENCY_KEY_REUSED`. Alle fünf Fehlercodes
bleiben außerhalb des Race-Fensters unverändert.

**Deterministischer Gate-Test:** `rooms-gate-race.integration.test.ts` (neu) hält über
`RoomReadGate`/`GatedRoomRepository` den zweiten Raumread an, bis beide Requests ihren initialen
Receipt-Lookup abgeschlossen haben und der erste committet und geantwortet hat – ohne Sleeps,
Retries oder gelockerte Assertions. Er deckt Rotation (`200/200`, `rotated`/`replayed`, Version 2,
ein `rotate`-Receipt) und Host-Leave (beide minimales Ack, genau eine `room.closed`-Publikation,
Version 2, ein `leave`-Receipt) ab.

**Nachweis:** Gate-Test 30/30 Läufe grün, bestehender Rotationstest 30/30 isoliert grün, drei
vollständige Backend-Suiten je 42 Dateien / 358 Tests grün; Typecheck, Lint und Format grün.
Restrisiko: Replays gelten nur innerhalb der Receipt-Aufbewahrung (ADR-003 §16), echte parallele
Fremdkommandos bleiben bewusst Konflikt/Not-Found, und es gibt keinen Mehrinstanz-/Langzeit-Soak.

## Nachweismatrix

- `rooms.unit.test.ts`: Alphabet/CSPRNG-Form, kanonischer SHA-256-Hash, Scope-/Payload-Bindung und
  nebenläufigkeitssichere synchrone User-/IP-Join-Budgets.
- `rooms.integration.test.ts`: echte Indizes, Rohdokument ohne Klartextcode, Unique-Kollision,
  parallele identische Creates, strikte HTTP-/Cookie-/Origin-Grenzen, `PublicUser`-Snapshots,
  Host-/Fremdzugriff, Rotation/alter Code und Versionskonflikte. Vier parallele neue Gäste ergeben exakt
  drei erfolgreiche Joins und ein `ROOM_FULL`; identische Joins und gleiche/abweichende Rotationen
  belegen atomare Find-/Update-Prädikate statt Vorabread-Schutz.
- `rooms-gate-race.integration.test.ts`: deterministische Barriere für identische Rotation und
  Host-Leave; der zweite Raumread wird erst nach beiden Receipt-Lookups und dem Commit des Gewinners
  freigegeben. Keine Sleeps/Retries.
- `rooms-replays.integration.test.ts`: Create-/Rotate-Verlust nach Service-Neustart ohne Codeeffekt,
  bewusste Folgerotation mit neuer Request-ID, alter Join nach Rotation/Ablauf, No-op im vollen Raum,
  Ehemaligen-`NOT_FOUND`, Payload-Reuse, minimale Leave-Replays, Host-Close sowie codesfreie Ereignisse.
- `rooms-lifecycle.integration.test.ts`: Lobbyablauf trotz noch gültigem rotiertem Code, sichtbare
  `ROOM_CLOSED`-Fehler, `in_progress`-Negativfälle ohne Start-/Engine-Implementierung und das
  REST-Join-Rate-Limit inklusive `Retry-After`.
- Bestehende Auth-/Runtime-/Engine-Suites bleiben Bestandteil der Root-Regression. Der T003-Built-Main-
  Smoke prüft weiterhin Auth; der T005-Smoke prüft zusätzlich die reale Rooms-Komposition.

Räume werden ausschließlich über die echte HTTP-App beziehungsweise den späteren Realtime-Use-Case
`leaveRoom` aufgerufen. Negative Responses, Snapshots und Ereignismaterialien werden gegen Codes,
Code-Hashes, Receipts, E-Mails und fremde private Daten geprüft. In ersten erfolgreichen Create-/Rotate-
Responses ist der Code selbstverständlich erwartet und wird dort nicht als Leck gewertet.

## Ausführung

```bash
pnpm install --frozen-lockfile
pnpm --filter @casetogether/backend exec vitest run test/rooms.unit.test.ts test/rooms.integration.test.ts --reporter=dot
pnpm --filter @casetogether/backend exec vitest run test/rooms-replays.integration.test.ts --reporter=dot
pnpm --filter @casetogether/backend exec vitest run test/rooms-lifecycle.integration.test.ts --reporter=dot
pnpm --filter @casetogether/backend test
pnpm build
node apps/backend/test/support/built-main-smoke.mjs
node apps/backend/test/support/built-rooms-main-smoke.mjs
```

Der reguläre `vitest run`-Exit ist der Integrationstestnachweis; Watch-Modus oder ein weggelassener
DB-Test gilt nicht. Der Built-Rooms-Smoke gibt nur Statuscodes, Room-Version/Mitgliederzahl und die
unverfängliche Binaryversion aus, niemals Codes, Cookies oder DB-URI. Er beendet HTTP-Server,
MongoClient und `mongod` auch im Fehlerfall und entfernt sein temporäres DB-Verzeichnis.
