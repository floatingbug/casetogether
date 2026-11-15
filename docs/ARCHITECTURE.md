# Architektur

## 1. Überblick und verbindliche Verträge

Modularer Monolith mit zwei Anwendungen und einem gemeinsamen Contract-Package:

- `apps/frontend`: Vue-3-SPA
- `apps/backend`: Express-API und Socket.IO im selben Node-Prozess im MVP
- `packages/shared`: framework-neutrale TypeScript-Typen und Zod-Schemas

MongoDB ist die persistente Datenquelle. Die Game Engine ist deterministisch. Ein kuratierter Fragenkatalog mit Referenzantworten bildet den vollständig spielbaren Basismodus. Ein KI-Provider ist optionaler, austauschbarer Adapter und weder für Backend-Start noch Readiness oder Spielzüge erforderlich.

Maßgebliche Entscheidungen:

- `docs/adr/0001-ki-dialoge-optional.md`: vollständiger Katalogpfad ohne KI
- `docs/adr/0002-http-only-auth-sessions.md`: revozierbare HttpOnly-Cookie-Sessions für REST und Socket.IO
- `docs/adr/0003-idempotenz-versionierung-konsistenz.md`: Idempotenz, getrennte Versionen, CAS und Standalone-MongoDB

Maschinenlesbarer REST-Vertrag: `contracts/openapi.yaml`. DTO-/Zod-Referenz: `contracts/shared-types.md`. Socket-Vertrag: `contracts/events.md`. Diese Architekturübersicht dupliziert nicht ersetzend einzelne Payloadfelder.

## 2. Backend-Module und Autorität

- `identity`: Registrierung, Login/Logout, Argon2id-Passwort-Hashes, persistierte Auth-Sessions; Autorität für Identität
- `rooms`: private Räume, gehashte Einladungen, Mitgliedschaft und Hostrolle; Autorität für Raumberechtigungen
- `cases`: statische, versionierte Fallinhalte einschließlich Katalog, Referenzantworten und serverseitiger Wahrheit
- `game-sessions`: Lifecycle, persistierter autorisierter Zustand, Idempotenz-Receipts und Version
- `game-engine`: ausschließlich deterministische Katalogaktionen, Hinweise, Phasen und finale Bewertung
- `dialogue`: Anwendungsfall für Befragung, Sichtbarkeitsprojektion und Wahl zwischen Referenzantwort und optionaler KI-Formulierung
- `ai`: optionaler Provider-Adapter, strukturierte Ausgabevalidierung, Prompttemplates sowie Rate-/Kostenlimits; keine Zustandsautorität
- `realtime`: Socket.IO-Authentifizierung, autorisierte Eventprojektion, Präsenz und Synchronisation; keine direkte Engine-/DB-Geschäftslogik im Handler
- `chat`: persistierter Gruppenchat mit idempotenten Message-IDs
- `billing`: später, nicht MVP-kritisch

Controller, Socket-Handler und Vue-Komponenten enthalten keine duplizierten Spielregeln. REST und Socket.IO rufen für gemeinsame Aktionen dieselben Application Use Cases auf.

## 3. Kommunikationsmuster

REST (`/api/v1`):

- Registrierung, Login, Logout und aktueller Nutzer
- Liveness/Readiness; optionale KI ist kein Readiness-Kriterium
- private Räume erstellen, per Code beitreten, lesen und Einladung rotieren
- sichere Fallzusammenfassungen auflisten und Spiel als Host starten
- Room-/Game-Snapshot nach Laden, Reconnect, Eventlücke oder Versionskonflikt abrufen
- gemeinsame finale Lösung abgeben und deterministisch auswerten

Socket.IO:

- autorisierte Raumverbindung/Snapshot-Synchronisation und Lobby verlassen
- flüchtige Präsenz, Raum-Lifecycle-Events und persistierter Gruppenchat
- Katalog- und optional getrennte Freitextbefragung
- empfängerspezifische Spielereignisse, Snapshots und Fehlerrückmeldungen
- Reconnect mit `room:join`; keine clientseitige Eventhistory als Autorität

Es gibt kein generisches `game:action` im MVP. Jeder Command hat ein striktes, diskriminiertes Schema. REST und Socket.IO verwenden fachlich dieselben Membership-, Authz-, Idempotenz- und Fehlercodes gemäß den Shared Contracts.

## 4. Zustände und Versionen

- Ein Raum besitzt `waiting`, `ready`, `in_progress` oder `closed` sowie eine eigene Room-Version.
- Eine gestartete Game Session beginnt als `investigating` und endet als `completed` oder `abandoned`. Sie besitzt eine davon getrennte Sessionversion. Interne `startIntent`-Zustände `pending`, `prepared` und `superseded` dienen ausschließlich Crash-Recovery und sind keine öffentliche Phase oder Session; sichtbar wird erst die verknüpfte prepared Session.
- `waiting` bedeutet ein Mitglied, `ready` zwei bis vier Mitglieder. Der Host startet nur in `ready` mit einem publizierten Fall; die publizierte `CaseVersion` wird serverseitig fixiert.
- Die finale Abgabe akzeptiert nur `suspectId`, `clientRequestId` und `expectedVersion`. Bewertung, Auflösung und Abschluss entstehen atomar serverseitig. Jedes Mitglied darf nach Gruppenabsprache abgeben; Voting ist kein MVP-Bestandteil.
- Präsenz und Chat verändern keine Sessionversion; Chat verändert auch keine Room-Version und wird über Message-ID/Chronologie dedupliziert.
- `expectedVersion` schützt start, room leave, invitation rotate, Befragung und Finale mit Compare-and-Swap. Idempotente Replays erhöhen keine Version.

## 5. Game Engine und Fallgeheimnisse

Die Engine verwaltet serverseitig:

- kanonische Lösung und Auflösung
- Sessionphase und erlaubte Übergänge
- raumöffentliche und spieler-private Hinweise
- Charakterwissen, Geheimnisse und zulässige Aussagen
- Katalogfragen, deren `actor`-/`room`-Sichtbarkeit und Freischaltbedingungen
- fest gepflegte Referenzantworten und deterministische Folgefragen/Hinweise
- finale Bewertung aus fixierter Fallversion und autoritativem State

Clients erhalten nur sichere Projektionen: Fallzusammenfassung, öffentliche Verdächtigenbeschreibung, aktuell sichtbare Fragen, autorisierte Dialoge/Hinweise und erst nach `completed` die `CaseResolution`. Nicht freigeschaltete Fragen, Referenzantworten, Trigger, private Daten anderer Spieler und Fallwahrheit werden nicht inaktiv oder versteckt übertragen, sondern serverseitig weggelassen.

Dieselbe Katalogaktion erzeugt mit Referenzdarstellung, KI-Formulierung und KI-Fallback dieselben kanonischen Hinweise, Folgefragen, Phasen und Bewertungen. Die Engine akzeptiert keine vom Modell behaupteten Fakten oder State-Patches.

## 6. Datenfluss einer Katalogbefragung

1. Client sendet `suspect:question` mit `mode = catalog`, `sessionId`, `suspectId`, `questionId`, `clientRequestId` und `expectedVersion`.
2. Realtime-Gateway prüft Auth-Session und Origin beim Handshake sowie aktuelle Raummitgliedschaft und Payload am Use-Case-Eingang.
3. Der Use Case prüft Idempotenz-Receipt bzw. in-flight Request, Phase, Version, Rate Limit und Berechtigung.
4. Die Game Engine prüft die sichtbare Katalogfrage der fixierten Fallversion und bestimmt deterministisch Referenzantwort, Kontextfreigabe und erlaubte Kandidatenänderungen. Dieser Schritt benötigt keinen Provider.
5. Ohne aktivierten Provider wählt der Dialogue-Use-Case unmittelbar die Referenzantwort. Mit Provider kann der AI-Service aus minimiertem, freigegebenem Kontext ausschließlich eine Antwortdarstellung erzeugen.
6. Der serverseitige `DialogueProvider` aus `specs/ai-suspects.md` akzeptiert ausschließlich striktes `{ dialogue: string }` (1–4000 Zeichen) und liefert den diskriminierten `AiProviderResult`-Union. Pro Use-Case-Ausführung gibt es höchstens einen Versuch mit 5 s Timeout/600 Output-Tokens ohne Adapter-Retry. Der T009-Use-Case reserviert vor dem Aufruf atomar einen von höchstens 60 Versuchen des Sessionbudgets; bei erschöpftem Budget wird kein Provider aufgerufen. Eine neue Ausführung ohne Erfolgs-Receipt darf erneut reservieren/aufrufen und zählt erneut. Zusatzfelder/State-Patches verändern niemals Engine-State. Providerfehler, Timeout, Budgetgrenze oder ungültige Formulierung verwenden im Katalog die vorhandene Referenzantwort als `fallback`.
7. Erfolg entsteht erst durch atomaren Session-CAS: State, Antwort, Receipt, persistierte Eventrohdaten und Versionserhöhung werden einmal geschrieben. Ein Versionsverlust wird nicht mit einer anderen Version erneut ausgewertet, sondern als `VERSION_CONFLICT` gemeldet.
8. Erst nach erfolgreicher Persistenz erhält jeder autorisierte Empfänger sein eigenes, bereits bereinigtes `game:event`; das Ack trägt dasselbe logische Event. Private Eventteile werden für andere Empfänger entfernt beziehungsweise komplett nicht gesendet.
9. Client dedupliziert Event/Ack anhand Event-ID und Version. Bei Versionslücke lädt er den Snapshot und wendet kein Delta auf alten State an. Start-/terminale Events tragen vollständige Game-Snapshots; jede andere zulässige Delta-Anwendung muss den resultierenden lokalen Stand erneut gegen `GameSnapshotSchema` validieren.

Ein identischer Retry erfolgt mit derselben `clientRequestId`, nutzt Receipt bzw. in-flight-Deduplizierung und ruft weder Engine noch Provider erneut auf. Stale abgelehnte Requests erfüllen keine „bereits angenommene Katalogaktion“; erst der erfolgreiche CAS ist ihre Annahme.

## 7. Optionale Freitext-KI

`mode = free_text` ist ein separater, diskriminierter Socket-Payload und kein Alternativformat des Katalogpfads. Freitext benötigt einen verfügbaren Provider und untrusted-Input-/Output-Validierung. Er hat keine Engine-Wirkung, ist actor-only und erzeugt keine Hinweise, Folgefragen oder abschlussrelevanten Fakten.

Ohne Provider oder nach ungültiger/erfolgloser Modellantwort liefert nur dieser optionale Zweig `AI_UNAVAILABLE`. Der Server errät keine passende `questionId` und erfindet keine Referenzantwort. Ein erfolgreicher Freitextdialog wird persistiert und erhöht als sichtbare Sessionänderung die Version einmal, modifiziert aber nicht den deterministischen Engine-State. Tests und CI verwenden ausschließlich Mocks; der Basispfad provoziert nachweislich null Provideraufrufe.

## 8. Persistenz und Konsistenz

- Autoritative Room- bzw. Sessionmutationen erfolgen in Repositories mit atomaren Bedingungen und eindeutigen Indizes, nicht im Controller/Socket-Gateway.
- Versions-Receipt und nichttextuelle Ergebnisverweise eines erfolgreichen Commands werden persistent gespeichert. Gleicher Key + gleicher Payload-Hash verhindert Mutation/Broadcast erneut und liefert nur erneut autorisierte logische Ergebnisse; gleicher Key + anderer Hash erzeugt `IDEMPOTENCY_KEY_REUSED`. Reiche Daten erfordern weiterhin Mitgliedschaft; nur minimale Leave-/Secret-Replay-Marker haben die dokumentierte Ausnahme.
- Eine Game Session kapselt State, Dialog/Ereignisrohdaten, erfolgreiche Receipts und versuchsbezogene AI-Budgetmetadaten im MVP in einem Dokument. Broadcast-Projektionen werden empfängerspezifisch nach dem Commit erzeugt. Providerreservierungen erhöhen atomar einen eigenen Zähler unter `version`-/`phase`-Bedingung vor dem Aufruf, aber weder Game Version noch Engine-State/Events. Kein Feldupdate ersetzt das Gesamtdokument. Die Dokumentgröße wird begrenzt/überwacht; spätere Auslagerung benötigt ADR/Migration.
- Join besitzt kein `expectedVersion`, sondern ein atomares Room-Prädikat für Code, Ablauf, Status, Nichtmitgliedschaft, `$size(members) < 4` und Receipt-Eindeutigkeit. Replay wird per actor-gebundenem Receipt-Index auch nach Rotation gefunden, aber nur bei fortbestehender Mitgliedschaft projiziert.
- Chat nutzt getrennte `messages` mit eindeutigem `(roomId, senderUserId, clientRequestId)` und Broadcast erst nach Insert.
- Nur erste erfolgreiche Create-/Rotate-Responses enthalten den Einladungscode. Persistente Replays sind diskriminierte codefreie `SecretReplayResponse`-Objekte; eine bewusste Rotation mit neuer Request-ID ist nach verlorenem Code erforderlich.
- Der mehrstufige Spielstart wird mit eindeutigem `gameSessions.roomId`, persistentem `startIntent` samt Actor/Room/Request-/Payload-/Version-/Case-Bindung und Room-CAS gegen parallele Starts und Crashzustände abgesichert. Nur exakt passende Intents setzen `pending`/`prepared` fort; abweichende Pending-Starts liefern `OPERATION_IN_PROGRESS`. Details, Superseding und die 15-Minuten-Cleanup-Grenze stehen in ADR-003; der MVP setzt keine Replica-Set-Transaktion voraus.
- Versionssprünge sind bei privaten Events zulässig. Snapshots über REST oder `room:sync` sind die Reparaturquelle nach Reconnect, Lücke, Schemafehler oder Konflikt. Codesfreie Rotationsevents verhindern unnötige Room-Versionslücken.

Details: `docs/DATABASE.md`.

## 9. Sicherheit und Datenschutz

- Auth nutzt signierte, zufällige, serverseitig revozierbare Session-IDs in `HttpOnly`-`SameSite=Lax`-Cookies; Produktion erzwingt `Secure`. Keine Tokens im Browser-Speicher oder Socket-Query.
- Unsafe REST verlangt Origin-/Fetch-Metadata-Prüfung und JSON; CORS besitzt exakte Origin-Allowlist mit Credentials. Socket.IO prüft Handshake-Origin und Auth sowie Mitgliedschaft bei jedem Event.
- Passwörter werden mit Argon2id und eigenem Salt gehasht. Einladungscodes besitzen 60 Bit Entropie, werden kanonisiert gehasht, laufen ab und sind brute-force-/rate-limitiert.
- Öffentliche DTOs, Player-private-DTOs und Server-secret-Daten sind getrennte Typen/Projektionen. Ressourcen fremder Nutzer liefern bevorzugt `NOT_FOUND`, nicht deren Existenzdetails.
- Jedes externe Datum und jede LLM-Ausgabe ist untrusted. Prompt-/Systemgrenzen werden serverseitig erzwungen; Provider erhalten nur minimierte freigegeben Kontexte.
- Keine Secrets im Repository oder Frontend-Bundle. Provider-API-Schlüssel sind optional, ausschließlich serverseitig und kein Start-/Readiness-Spielzug-Kriterium.
- Logs enthalten keine Passwörter, Tokens, Cookies, Einladungscodes, privaten Hinweise, vollständigen Dialog-/Promptinhalte oder geheimen Lösungen.

Details: `specs/security-boundaries.md` und `docs/SECURITY_PRIVACY.md`.

## 10. Skalierung

MVP: eine Backend-Instanz. Erst späteres Horizontal-Scaling ergänzt Socket.IO-Adapter, verteilte in-flight-Koordination und gemeinsame Rate Limits; vorher dürfen keine Workloads auf mehrere Instanzen verteilt werden. Keine vorzeitige Microservice-Aufteilung oder kostenpflichtige Infrastrukturaktivierung.
