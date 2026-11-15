# Deterministische Game Engine

Dieses Backend-Modul enthält die reine Spielregel-Autorität und den ersten vollständigen deutschen Fall **„Der stille Glockenschlag“** (`der-stille-glockenschlag`, Version `1.0.0`). Es hat keine HTTP-, Socket-, Datenbank-, Frontend- oder AI-Abhängigkeit.

## Öffentliche Backend-API

`index.ts` exportiert:

- `startGame`: validiert serverseitig übergebene Raum-Mitgliedschaft, Host und `expectedVersion`; zwei bis vier Mitglieder beginnen direkt in `investigating`, Game-Version 1.
- `askCatalogQuestion`: verarbeitet ausschließlich den diskriminierten Shared-Vertrag `mode = catalog` und erzeugt die kuratierte Referenzantwort mit `answerSource = reference`.
- `submitFinalSolution`: bewertet nur `suspectId`, Idempotenzdaten und `expectedVersion`; Bewertung, finale Abgabe und Abschluss entstehen in einem Übergang.
- `abandonGame`: besitzt keinen Actor-/Client-Abbruchcommand und akzeptiert ausschließlich die serverseitigen Gründe `expired` und `server_timeout`.
- `getGameSnapshot`: erzeugt sichere, empfängerspezifische Shared-DTOs; Nichtmitglieder erhalten `NOT_FOUND`.
- die Falldefinition und serverseitigen internen Typen für die spätere Backend-Integration. Diese Typen und die Fallwahrheit sind **keine** Client-Exports.

Alle Funktionen sind synchron und mutieren ihren Eingabestand nicht. Zeitstempel werden mit jedem Command übergeben und als UTC-Serverzeit validiert. IDs, Payload-Hashes, Dialoge, Hinweise, Punkte und Events werden ohne Zufall, Wanduhr oder externe Aufrufe abgeleitet. Fehler werden als diskriminiertes `EngineResult` zurückgegeben. Version- und Berechtigungsfehler erzeugen keinen Receipt und verändern den bisherigen Stand nicht.

## Fall und kanonische Bewertung

Der Fall enthält drei verschiedene Verdächtige, zwölf konkrete Katalogfragen mit stabilen IDs und ausführlichen Referenzantworten, dreizehn Hinweise sowie private Charakterdefinitionen und serverseitige Fallwahrheit. Der kuratierte Katalog bildet sämtliche Entscheidungen, Folgefragen und Beweise ab; ein Freitext- oder Providerzweig ist weder vorhanden noch erforderlich.

Sechs entscheidende Beweis-Clues bringen jeweils 10 Punkte:

1. Miriams signierte Konzentratentnahme (actor-only),
2. ihr zugegebenes Teearrangement (raumöffentlich),
3. der dokumentierte Servierweg (raumöffentlich),
4. Chargenabgleich und fehlender Messkolben (actor-only),
5. Jonas’ geschlossenes Kontrollprotokoll (raumöffentlich),
6. Selins lückenloser Livestream (raumöffentlich).

Die korrekte Täterwahl bringt zusätzlich 40 Punkte; das Maximum ist 100. Eine Abgabe ist vertragsgemäß jederzeit möglich: Auch ohne Hinweise ist eine korrekte Abgabe `correct`, erhält aber nur 40 Punkte. Eine falsche Abgabe ist `incorrect`, erhält keinen Täterbonus und behält nur die kanonischen Beweispunkte. Ein fehlender Beweis blockiert den Abschluss nicht. Gruppenpunkte zählen jeden entscheidenden Clue einmal, selbst wenn mehrere Mitglieder privates Wissen unabhängig aufdecken.

Ein vollständiger Erfolgspfad in den Tests lautet:

1. Jonas zur Teetasse,
2. Jonas zum Rundgang,
3. Jonas persönlich zum Inventurprotokoll,
4. Selin zum Veranstaltungsprogramm,
5. Miriam zur Teebestellung,
6. Miriam persönlich zum fehlenden Konzentrat,
7. Selin zum Servierweg,
8. Jonas zur Sicherheitszentrale,
9. Selin zur Bühnenansprache,
10. Finalabgabe gegen Miriam Vogt durch ein beliebiges Raummitglied.

Dabei decken nur dieselben Personen jeweils ihre actor-only Voraussetzungen auf; raumöffentliche Voraussetzungen dürfen von anderen Mitgliedern stammen. Die Auflösung erklärt die vollständige Beweisführung und wird erst nach `completed` projiziert. `abandoned` enthält weder Ergebnis noch Auflösung.

## Idempotenz, Versionen und Eventausgabe

- Der Receipt-Scope lautet `(actorUserId, operation, sessionId, clientRequestId)`. Actor und Operation gehören deshalb auch zur deterministischen ID-Ableitung.
- Gleicher Scope und identischer Payload-Hash liefern das gespeicherte logische Ergebnis ohne neue Mutation, Version, Dialoge, Hinweise oder Eventverteilung. `replayed: true` ist Integrationsmetadatum: T009 darf dabei kein Event erneut broadcasten. Das logische Ergebnis mit `replayed: false` ist JSON-identisch.
- Gleicher Scope mit anderem Hash erzeugt `IDEMPOTENCY_KEY_REUSED`.
- Neue Commands verlangen die aktuelle Version. `VERSION_CONFLICT.details.currentVersion` enthält den autoritativen Stand. Identische historische Replays werden vor Phase/Version erkannt und bleiben auch nach einem späteren terminalen Übergang ohne Mutation zulässig.
- Eine erfolgreiche Mutation erhöht die Version genau einmal. Start- und terminale Events tragen vollständige Snapshots; Katalogevents bleiben `investigating`.
- `recipientEvents` ist bereits pro Mitglied bereinigt. `event: null` bedeutet **kein Event an diesen Empfänger senden**. Ein nicht leeres Event bei einer fremden actor-only Aktion enthält ausschließlich ausdrücklich raumöffentliche Effekte und `dialogue: null`.
- Snapshots und Events werden vor der Rückgabe mit den strikten Schemas aus `@casetogether/shared` validiert. Fallwahrheit, Charakter-Geheimnisse, Trigger, nicht freigeschaltete Referenzen, Receipts und Hashes werden nicht in diese Projektionen übernommen.

## Integrationsgrenzen

Die Engine erzeugt einen neuen vorgeschlagenen Stand; sie persistiert ihn nicht. Zwei Reducer-Aufrufe auf demselben alten Stand erzeugen daher bewusst zwei unabhängige Kandidaten. Die tatsächliche „genau ein Gewinner“-Garantie muss T009 mit MongoDB-CAS auf `sessionId + version` umsetzen und den Verlierer anschließend auf dem Gewinnerstand als `VERSION_CONFLICT` klassifizieren. Diese Tests modellieren genau diese Reihenfolge; sie behaupten keine externe Transaktion, Eventverteilung oder Socket-Garantie.

Raum-CRUD, aktuelle Auth-/Membership-Auflösung, `startIntent`/Recovery, persistierte Events/Receipts, TTL-Jobs, REST-/Socket-Handler und Broadcasting gehören ebenfalls T009 beziehungsweise den für Räume und Realtime zuständigen Modulen. Providerport und KI-Formulierung gehören nicht zu T007; der Basispfad enthält bewusst keinen solchen Port und keinen Providerimport.

## Tests

Die Tests liegen unter `apps/backend/test/game-engine/`. Sie befahren den vollständigen Erfolgsweg, erreichen zusätzlich alle zwölf Katalogfragen über die tatsächlich produzierte Verfügbarkeit und decken Startgrenzen, jeden Freischaltungstyp, falsche/korrekte Finals, kanonische Punkte, Replay, Versionskonflikte, Immutabilität, Sichtbarkeit, Schema- und Leak-Grenzen sowie null Netz-/Provideraufrufe ab.

```bash
pnpm --filter @casetogether/backend exec vitest run test/game-engine
pnpm --filter @casetogether/backend typecheck
```
