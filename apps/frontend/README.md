# CaseTogether Frontend

Vue-3-SPA mit Composition API, TypeScript strict, Vue Router, Pinia und typisierten REST-/Socket.IO-Clients. Enthalten sind Registrierung/Login, private Räume, Lobby/Präsenz/Gruppenchat, Fallauswahl, Katalogbefragung, Hinweise und die serverbestätigte finale Abgabe.

## Entwicklung

Vom Repository-Stamm:

```bash
pnpm --filter @casetogether/frontend dev
```

Vite leitet `/api` und `/socket.io` an `http://127.0.0.1:3000` weiter. Socket.IO verwendet den Standardpfad `/socket.io`, `withCredentials: true` und keine Auth-Tokens in Query oder Handshake-Body. Der Backend-Prozess muss die tatsächliche Frontend-Origin gemäß `docs/DEVELOPMENT.md` erlauben. Proxy und Origin sind kein Autorisierungsbeweis; Cookie, CSRF-/Origin-Prüfung, Mitgliedschaft, Hostrolle, Versionen und Spielregeln bleiben Serversache.

Bei lokalen HTTP-LAN-Origins kann `crypto.randomUUID()` im Browser fehlen. Request-IDs verwenden diese Funktion bevorzugt und erzeugen sonst aus 16 Bytes von `crypto.getRandomValues()` eine RFC-konforme UUID v4. Das ist ausschließlich Kompatibilität für lokale Entwicklung; produktive HTTPS- und Cookie-Anforderungen bleiben unverändert.

## Deployment (Vercel)

Das Frontend ist als statische Vite-SPA für ein getrenntes Hosting vorgesehen. REST und Socket.IO verwenden beide dieselbe Build-Zeit-Variable `VITE_API_ORIGIN` (`src/config/api-origin.ts`):

```bash
VITE_API_ORIGIN=https://api.casetogether.tasse-voll-code.de
```

- Die Variable ist optional und wird beim Build eingelesen. Ohne Wert bleibt das bisherige Verhalten exakt erhalten: REST-Pfade sind relativ und Socket.IO verbindet sich mit der Origin der ausgelieferten Seite (lokale Entwicklung über den Vite-Proxy, Preview, Tests).
- Ein gesetzter Wert muss eine reine absolute Origin ohne Pfad, Query, Hash oder Zugangsdaten sein; `https` ist immer erlaubt, `http` nur für `localhost`/`127.0.0.1`. Ungültige Werte brechen den App-Start mit einer klaren Fehlermeldung ab (nicht erst zur Laufzeit einer Anfrage).
- Der Wert ist kein Secret und darf im Build-Artefakt sichtbar sein.
- Cookies (`credentials: 'include'`, `withCredentials: true`), `SameSite`/`Secure`, CORS und die erlaubte Frontend-Origin (`FRONTEND_ORIGIN`) sind Backend-/Host-Konfiguration und nicht Teil dieses Frontends. Für die Vercel-Origin muss das Backend die entsprechende Herkunft zulassen; das Frontend erfindet dafür keine Endpunkte.

## Struktur und Datenautorität

- `src/api/http.ts` kapselt Fetch mit JSON, `credentials: 'include'` und strikten Shared-Fehler- und Erfolgshüllen.
- `src/api/auth.ts`, `rooms.ts`, `cases.ts` und `game-sessions.ts` sind getrennte REST-Services. Komponenten enthalten keine Fetch-Logik.
- `src/realtime/transport.ts` kapselt Socket.IO. `client.ts` validiert Requests und Pflicht-Acks und normalisiert `connect_error.data.error` sowie den initialen Long-Poll-`ErrorResponse`. Transport-Fehlertexte sind kein fachlicher Steuerkanal.
- `src/realtime/client-state.ts` verwaltet unabhängig Room-Version, Game-Version, unversionierte Präsenz und Chat-IDs/Chronologie. Events/Acks/Snapshots werden nach IDs und Versionen dedupliziert. Nur `v + 1`-Deltas werden nach erneutem kompletten `GameSnapshotSchema`-Check angewendet. Lücken und Schemafehler führen zu `room:sync` oder autoritativen REST-Snapshots; ältere Daten ersetzen keinen neueren Stand. Start- und terminale Events tragen vollständige Snapshots.
- `src/stores/auth.ts` enthält ausschließlich das vertragliche `PublicUser` und Auth-UI-Zustände. `src/stores/game.ts` enthält nur die aktuelle, für den angemeldeten Nutzer autorisierte Room-/Game-Projektion und flüchtige Aktions-/Verbindungszustände. Nichts davon wird persistiert. Logout/Leave/Reset verwirft private Projektionen.
- `src/components/` und `src/views/` rendern Serverdaten über Vue-Textinterpolation. Es gibt kein `v-html`, keine Client-Bewertung, keine Frontend-Version von Engine-Regeln und keine Anzeige einer Auflösung vor einem bestätigten `completed`-Snapshot.

Nach `connect` folgt regulär `room:join`. Ein unbestätigter `room:leave` behält exakt Request-ID und Payload und wird nach Reconnect **direkt ohne vorheriges Join/Sync** wiederholt; nur das minimale Leave-Receipt beendet diesen Pfad. Andere unbestätigte Actions behalten ebenfalls ihre Request-ID. Nach einem definitiven `VERSION_CONFLICT` ersetzt ein Snapshot den aktuellen Stand; eine bewusst neue fachliche Aktion erhält neue UUID und Expected-Version.

## Einladungen und verlorene Secrets

- Der Klartextcode aus `outcome = created | rotated` ist nur ein flüchtiger Host-Anzeigezustand zum Lesen/Kopieren. Er erscheint nicht in Local-/Session-Storage, URLs oder Logs.
- `outcome = replayed` wird als diskriminierte `SecretReplayResponse` behandelt: `invitation = null`, kein erfundener alter/neuer Code und keine nachträgliche Rekonstruktion.
- Bei Lost Secret öffnet der Host zunächst seinen weiterhin autorisierten Raum. Nur die ausdrückliche Aktion „Neuen Code durch Rotation erzeugen“ startet eine neue Rotation mit neuer UUID und aktueller Room-Version. Der alte Code wird dabei ungültig.
- Join-Retries verwenden weiterhin denselben normalisierten Code und dieselbe Request-ID. Dadurch bleibt der vertragliche Join-Receipt-Pfad nach einer zwischenzeitlichen Rotation nutzbar; Rich-Daten liefert nur ein neuer autorisierter Server-Snapshot.

## Katalog und finale Abgabe

Die Befragung bietet ausschließlich die serverseitig sichtbaren `availableQuestions` als verständliche Buttons. Kein Freitext, Provider oder API-Schlüssel ist für den Abschluss nötig. Pending-Karten zeigen höchstens die lokal gestellte Frage beziehungsweise Chatnachricht, aber niemals erfundene Antworten, Hinweise, Versionen oder Ergebnisse. Öffentliche und eigene private Hinweise/Dialoge kommen ausschließlich aus validierten Serverprojektionen; aus Versionslücken werden keine privaten Inhalte rekonstruiert.

Die finale Abgabe sendet ausschließlich `suspectId`, `clientRequestId` und `expectedVersion`. Auswahl und Punkte werden clientseitig nicht bewertet. Ergebnis, Feedback, Punkte und `CaseResolution` erscheinen erst aus dem erfolgreichen REST-/Event-Snapshot des Servers. `abandoned` erzeugt keine Auflösung.

## Bedienung und Zustände

Responsive Layouts decken Desktop, Tablet und Mobile ab. Formulare, Radio-Felder, Fragelisten, Dialoge und Aktionen sind tastaturbedienbar und beschriftet. Skip-Link, sichtbarer Fokus, Status-/Alert-Regionen, große Touch-Ziele und Text-Reflow sind vorgesehen. Lade-, Leer-, Fehler-, Offline-, Reconnect- und Pending-Zustände sind getrennt sichtbar. Kritische Spielaktionen sind ohne bestätigte Live-Verbindung gesperrt; deaktivierte Controls sind jedoch keine Sicherheitsgrenze.

## Tests und Integrationsgrenze

```bash
# Unit-, Client-, Store- und Komponententests mit Contract-Fakes
pnpm --filter @casetogether/frontend test

# Gezielte neue Game-/Realtime-Suiten
pnpm --filter @casetogether/frontend exec vitest run \
  test/api/game-contracts.test.ts \
  test/realtime/client-state.test.ts \
  test/realtime/client.test.ts \
  test/stores/game.test.ts \
  test/components/GameView.test.ts \
  test/components/RoomFlow.test.ts

# Bestehende hermetische Browser-Smokes; baut Shared und startet Vite automatisch
pnpm --filter @casetogether/frontend test:e2e
```

Die Vitest-Suite prüft unter anderem Create-/Rotate-Secret-Replays, Lost Secret, Join-Receipt nach Rotation, Leave-vor-Join, Reconnect/Lücken/stale Acks, Handshakefehler für WebSocket und Long-Poll, Event-/Ack-Deduplikation, Snapshot-Invarianten, Actor-private Projektionen und den vollständigen Katalogflow ohne Provider/UI-Freitext. Externe APIs und produktive Daten werden nicht verwendet.

Die vorhandenen Playwright-Smokes starten keinen Backend-/MongoDB-Prozess und fangen Auth-REST per Route-Interception hermetisch ab. Sie prüfen weiterhin Login/Registrierung/Logout, geschützte Navigation, Desktop-/Tablet-/Mobile-Reflow und leeren Browser-Storage. **Ein echter Backend-/Socket-E2E über den kompletten Mehrspielerflow ist nicht Bestandteil dieses Arbeitspakets und bleibt T010 vorbehalten.** Für reale Entwicklung müssen Backend und Datenbank separat verfügbar sein; auch dann werden keine Live-LLM-Aufrufe benötigt oder vom Frontend ausgelöst.
