# Architektur

## Überblick
Modularer Monolith mit zwei Anwendungen:
- `apps/frontend`: Vue 3 SPA
- `apps/backend`: Express API und Socket.IO auf demselben Node-Prozess im MVP
- `packages/shared`: gemeinsame Schemas und DTOs

MongoDB ist persistente Datenquelle. Die Game Engine ist deterministisch. Der KI-Provider ist ein austauschbarer Adapter.

## Backend-Module
- identity: Registrierung, Login, Session/JWT-Strategie
- rooms: private Räume, Einladungen, Mitglieder
- cases: statische Fallinhalte und Versionierung
- game-sessions: Lifecycle und persistierter Zustand
- game-engine: Regeln, Hinweise, Phasen, Lösung
- dialogue: Anwendungsfall zur Befragung eines Verdächtigen
- ai: Provider-Adapter und Prompt-Templates
- realtime: Socket.IO-Gateway und Event-Mapping
- chat: Gruppenchat
- billing: später, nicht MVP-kritisch

## Kommunikationsmuster
REST:
- Authentifizierung
- Räume erstellen/beitreten/abfragen
- Fälle auflisten
- Spielstand-Snapshot laden
- finale Lösung abgeben

Socket.IO:
- Live-Chat
- Präsenz und Raumereignisse
- Spielereignisse und freigegebene KI-Antworten
- Reconnect-/Snapshot-Synchronisierung

REST und Socket-Events rufen dieselben Application Use Cases auf. Keine doppelte Geschäftslogik.

## Game Engine
Die Engine verwaltet:
- kanonische Lösung
- Spielphase
- öffentliche Fakten
- private Hinweise pro Spieler, falls das Fallszenario dies vorsieht
- Charakterwissen und zulässige Aussagen
- Bedingungen zum Freischalten von Hinweisen
- finale Bewertung

Die Engine liefert freigegebene Kontextdaten an den AI-Service. Sie akzeptiert keine vom LLM behaupteten Fakten als Zustandsänderung.

## Datenfluss einer Befragung
1. Client sendet `suspect:question` mit `sessionId`, `suspectId`, `question`, `clientRequestId`.
2. Realtime-Gateway authentifiziert und prüft Raum-Mitgliedschaft.
3. Use Case prüft Phase, Rate Limit, Request-Duplikat und Berechtigung.
4. Game Engine erstellt minimierten, freigegebenen Kontext.
5. AI-Service erzeugt strukturierte Antwort.
6. Schema- und Regelprüfung.
7. Antwort und Event werden persistiert; Session-Version wird erhöht.
8. Autorisierte Empfänger erhalten Event.
9. Client aktualisiert UI anhand Version/Event-ID.

## Konsistenz
- Persistenz vor Broadcast.
- `clientRequestId` schützt vor wiederholter Verarbeitung.
- `version` steigt pro bestätigter Zustandsänderung.
- Reconnect erhält Snapshot mit Version.
- Konflikte bei konkurrierenden Aktionen werden serverseitig erkannt und sauber zurückgemeldet.
- Für kritische MongoDB-Updates atomare Updates oder Transaktionen prüfen; MVP-Design darf nicht von nicht aktivierten Replica-Set-Funktionen ausgehen.

## Sicherheit
- Authentifizierung via sicherem HttpOnly-Cookie oder dokumentierter Token-Strategie.
- Socket-Handshake authentifizieren.
- Raum-Mitgliedschaft für jedes Event prüfen.
- Einladungscodes kryptografisch zufällig, gehasht speichern, Ablaufzeit und Rate Limits.
- DTOs trennen öffentliche und private Daten.
- Keine Geheimnisse im Frontend-Bundle.
- LLM-Output ist untrusted.
- Datenschutz: Datenminimierung, Löschkonzept, Aufbewahrungsfristen und Datenschutzhinweise vor öffentlichem Launch prüfen.

## Skalierung
MVP: eine Backend-Instanz. Bei späterem Horizontal-Scaling Socket.IO-Adapter (z. B. Redis) und koordinierte Persistenz/Jobs ergänzen. Keine vorzeitige Microservice-Aufteilung.
