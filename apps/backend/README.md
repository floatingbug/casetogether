# Backend – Identity, Spielräume und MongoDB (T003/T005)

## Erforderliche Runtime-Konfiguration

Der produktive Entry Point `src/main.ts` verbindet sich vor dem HTTP-Listen mit MongoDB und legt
idempotent die erforderlichen Auth-Indizes auf `users`/`authSessions` sowie Raum-Indizes auf `rooms`
an. Ein Start mit nicht erreichbarer Datenbank oder ungültiger zwingender Konfiguration schlägt
kontrolliert fehl; dabei werden weder URI noch Secret oder Treiberdetails geloggt.

Erforderlich sind:

- `MONGODB_URI`: lokale beziehungsweise vorgesehene MongoDB-Verbindungs-URI, beginnend mit
  `mongodb://` oder `mongodb+srv://`.
- `SESSION_SECRET`: mindestens 32 Byte hochwertige Zufallsdaten, ausschließlich serverseitig. Es
  gibt **keinen** Default-, Entwicklungs- oder Provider-Ersatzwert. Das Beispiel in `.env.example`
  ist zu ersetzen, nicht produktiv zu übernehmen.
- `FRONTEND_ORIGIN`: exakte kommaseparierte Origin-Allowlist ohne Pfad oder abschließenden Slash;
  keine Wildcards.
- `NODE_ENV`: `development`, `test` oder `production`; `PORT` ist optional und standardmäßig 3000.

In Produktion ist das `ct_session`-Cookie `Secure`. Eine Secret-Rotation invalidiert wegen der
HMAC-Prüfung bestehende Cookies kontrolliert; abgelaufene Datensätze kann der TTL-Monitor später
entfernen. Secrets stammen aus der lokalen beziehungsweise hostseitigen Secret-Verwaltung und werden
niemals in Responses, Shared-Exports oder Logs geschrieben.

Start und Build:

```bash
pnpm --filter @casetogether/backend dev
pnpm --filter @casetogether/backend build
pnpm --filter @casetogether/backend start
```

Der Server bindet im MVP an `127.0.0.1`. OpenAI-/Provider-Werte werden weder für Start, Liveness
noch Readiness benötigt oder gelesen.

## System-Endpunkte

- `GET /api/v1/health` bleibt eine lokale Prozess-Liveness und führt keinen Datenbank- oder
  Provider-Check aus.
- `GET /api/v1/ready` führt pro Anfrage einen echten MongoDB-`ping` aus. Nur Ergebnis `ok: 1`
  liefert `200 ready`; fehlende, geschlossene oder fehlerhafte Verbindungen liefern ohne Interna
  `503 not_ready`.
- Beim gezielten Test-Composition ohne injizierten MongoDB-Adapter bleibt die bisherige ehrliche
  `503 not_ready`-Fallbacksemantik bestehen. Der Runtime-Entry Point verwendet immer den echten
  Adapter.

## Identity-API unter `/api/v1`

| Operation             | Verhalten                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register` | Strikte Zod-Eingabe, lowercase/getrimmte E-Mail, NFC/Trim für den Anzeigenamen, `201 PublicUser`, Auth-Cookie; Duplikate liefern `409 EMAIL_ALREADY_REGISTERED`.                    |
| `POST /auth/login`    | Normalisierte E-Mail und exakt unverändertes Passwort, `200 PublicUser` und neue Auth-Session; falsches Passwort und unbekanntes Konto liefern identisch `401 INVALID_CREDENTIALS`. |
| `GET /me`             | Autoritative User-Projektion aus gültiger persistierter Session; fehlerhafte, unbekannte, revozierte und abgelaufene Cookies liefern `401 UNAUTHENTICATED`.                         |
| `POST /auth/logout`   | Idempotente serverseitige Revocation eines gültig signierten Cookies und serielle Cookie-Löschung mit identischen Sicherheitsattributen, `204` ohne Body.                           |

Es gibt keine Bearer-/JWT-Alternative und keine clientseitig behauptete User-ID oder Rolle. Response-
Bodies enthalten ausschließlich die durch `PublicUserSchema` validierte ID und den Anzeigenamen.

### Passwort- und Sessiongrenzen

- `@node-rs/argon2` erzeugt `$argon2id$v=19$-PHC-Hashes mit eigenem 16-Byte-Salt, 32-Byte-Output,
`m=19456`, `t=2`, `p=1`. Schlechtere historische Parameter werden nach erfolgreichem Login neu
  gehasht. Passwörter werden nicht getrimmt, Unicode-normalisiert oder geloggt.
- Session-IDs enthalten 32 CSPRNG-Bytes. Der Cookie-Wert besteht aus Base64URL-ID und
  HMAC-SHA-256-Signatur mit zweckgebunden aus `SESSION_SECRET` abgeleitetem Schlüssel.
- MongoDB speichert ausschließlich `sessionIdHash` (SHA-256 der 256-Bit-ID), `userId`, Schema-/Zeit-
  und Revocationsdaten. Weder ID, Signatur noch Cookie-Header werden persistiert.
- `ct_session` besitzt `HttpOnly`, `SameSite=Lax`, `Path=/`, Sekunden-`Max-Age=604800`, absolutes
  `Expires` nach sieben Tagen und in Produktion `Secure`. `expiresAt <= now` und jedes gesetzte
  `revokedAt` werden unabhängig vom asynchronen TTL-Cleanup fachlich abgelehnt.
- Unsafe Requests benötigen einen erlaubten Origin, keine cross-site Fetch Metadata und bei Body
  `application/json`. Credential-CORS bleibt auf exakte Origins begrenzt. JSON ist auf 16 KiB
  begrenzt.

### Indizes und Rate Limits

`ensureAuthIndexes` erstellt idempotent unique `users.emailNormalized`, unique
`authSessions.sessionIdHash`, `(userId, revokedAt)` und den TTL-Index `expiresAt` mit
`expireAfterSeconds: 0`.

Auth-IP-Limits werden nach der Originprüfung, aber vor JSON-Parsing verbraucht: 10 Requests/5 min
über Login, Registrierung und Logout, sichere Preflights ausgenommen. Nach normalisierter Eingabe
wirken zusätzlich 5 Fehlversuche/15 min je Konto-Key mit Pending-Reservierungen gegen Parallelität.
Erfolge geben Pending-Slots frei. `429` enthält `Retry-After` und `details.retryAfterSeconds`.
IP-/Konto-Schlüssel liegen nur als zweckgebundene HMAC-Hashes in kurzlebigen Prozessfenstern vor.
Uhr und Fenster sind in Tests injizierbar; E-Mail-Klartext wird nicht in Routine-Logs geschrieben.
Diese Limits gelten bewusst für die dokumentierte einzelne Backend-Instanz.

## Private Spielräume unter `/api/v1`

| Operation                                | Verhalten                                                                                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /rooms`                            | Authentifizierter Host, initial `201 outcome=created` mit Room-Snapshot und neuem Code. Persistente Replays liefern `200 outcome=replayed`, `invitation=null` und keine reiche Room-Projektion.                                                |
| `POST /rooms/join`                       | Code-Join ohne `expectedVersion`; maximal vier Mitglieder. Bestehende Mitgliedschaft erzeugt einen atomaren No-op-Receipt ohne Versionsänderung.                                                                                               |
| `GET /rooms/{roomId}`                    | Nur aktuelle Mitglieder erhalten einen schema-validierten Snapshot mit `PublicUser`-Daten, `recentMessages=[]` und flüchtigem, in T005 leerem `presence`. Fremde erhalten `NOT_FOUND`, geschlossene/abgelaufene bekannte Lobbys `ROOM_CLOSED`. |
| `POST /rooms/{roomId}/invitation/rotate` | Nur Host in `waiting`/`ready` mit erwarteter Room-Version. Initial neuer Code und `outcome=rotated`; persistente Replays sind ausschließlich codefreie Secret-Marker.                                                                          |

`leaveRoom` ist zusätzlich als Repository-/Use-Case-Grenze für T006 implementiert, aus Sicherheits- und
Vertragsgründen aber **nicht** als REST-Endpunkt oder Socket.IO-Handler verdrahtet. Gewöhnliche Mitglieder
werden mit Room-CAS entfernt; ein Host schließt die Lobby. Beide Fälle speichern nur das minimal
replayfähige Ergebnis `{ roomId, roomVersion, closed }`. Nach erfolgreichem Verlassen kann derselbe Request
dieses Ack ohne Mitgliedschaft erneut liefern, niemals jedoch alte Mitglieder-/Raumdaten.

### Einladungen, Persistenz und Projektion

- Der Standardgenerator liest zwölf `randomBytes` und wählt mit den jeweils fünf niederwertigen Bits
  gleichverteilt aus den 32 Zeichen `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (60 Bit). Transport und Ausgabe
  gruppieren `XXXX-XXXX-XXXX`; für den SHA-256-Hash werden Bindestriche entfernt und Großbuchstaben
  kanonisiert.
- `rooms.invitation` enthält ausschließlich `codeHash`, `createdAt`, `expiresAt`. Klartextcode oder
  vollständige Secret-Responses befinden sich weder in `actionReceipts` noch in Snapshots, Events oder
  Routine-Logs. Initialer Code und Ablauf werden nur an den Host zurückgegeben.
- Receipts binden `(actorUserId, operation, aggregateId, clientRequestId)` über einen gehashten
  `lookupKey` und prüfen den SHA-256-Payload-Hash. Sie enthalten nur `roomId`, Room-Version,
  Event-ID/Close-Marker und technische Schlüsseldaten. Create nutzt `aggregateId=new`.
- `ensureRoomIndexes` erstellt unique `invitation.codeHash` und `actionReceipts.lookupKey`, den
  Receipt-Actor-/Operation-/Request-Index, den Membership-Index sowie TTL `deleteAfter`. Einladungen
  laufen 60 Minuten; Lobbys 24 Stunden nach Erstellung. Der fachliche Ablauf wird unabhängig vom
  asynchronen TTL-Monitor geprüft.
- Der New-Join verwendet ein einzelnes atomares `findOneAndUpdate` mit Code-/Ablauf-, Status-,
  Nichtmitgliedschafts-, Receipt- und `$expr $size(members) < 4`-Prädikat. Mitglied, Receipt, `ready`,
  Update-Zeit und Version werden in demselben Update gesetzt. Der No-op-Join verlangt ebenfalls atomar
  fortbestehende Mitgliedschaft und schreibt nur seinen Receipt, keine Version oder Broadcast-Wirkung.
- Join-Replay-Suche ist actor-gebunden und unabhängig vom später rotierten Code-Hash. Erst Payload-Hash,
  dann fortbestehende Mitgliedschaft und lesbarer Lobbyzustand entscheiden über einen aktuellen Snapshot;
  ehemalige Mitglieder erhalten `NOT_FOUND`.
- Rotate und Leave sind `expectedVersion`-CAS-Mutationen. Fehlgeschlagene CAS-Schritte erzeugen keinen
  Erfolgs-Receipt/Versionssprung. Replays dürfen keine Version oder Publication erneut erzeugen.
- Ergebnisobjekte enthalten optional `RoomPublication` mit aktuellen Empfänger-IDs und einem gegen das
  Shared-Schema validierten Room-Event. Join-, Rotate-, Leave-/Close-Erstmaterial besitzt keinen Code,
  Code-Hash oder Receipt. Replays und No-op-Joins besitzen `publication=null`; T006 versendet erst nach
  diesem persistierten Ergebnis.
- Join-Limits sind 10/5 min/Nutzer und 50/h/IP in der dokumentierten einzelnen Backend-Instanz. Join
  und Counter verwenden dieselbe injizierbare Uhr.

## Tests und Datenbank

```bash
pnpm --filter @casetogether/backend test
```

Unit-, Supertest-Integrationen und ein HTTP-`fetch`-Smoke verwenden für DB-Pfade ein echtes
temporäres `mongod 7.0.24`, kein In-Memory-Repository. Versionen, Binary-/Cachepfade,
Start-/Stop-Sequenz, Testumfang und die Vorgehensweise bei nicht verfügbarem Binary sind in
[`docs/DATABASE_TESTING.md`](../../docs/DATABASE_TESTING.md) dokumentiert. T005-konkrete Races,
Neustarts, Cleanup und der zusätzliche Built-Rooms-Smoke stehen in
[`docs/ROOMS_TESTING.md`](../../docs/ROOMS_TESTING.md). Tests benötigen keine produktive MongoDB,
externe Cluster, echten Secrets oder Live-LLMs.

## Bewusste Taskgrenzen

Socket.IO-Verbindungen, persistierter Chat, Spielstart, Game-Sessions und Spielregeln sind nicht Teil
von T005. `presence` bleibt flüchtig und wird nicht mit Room-Versionen persistiert. Durch REST-Logout
revozierte Sessions sind sofort für weitere Auth-Prüfungen ungültig; aktives Trennen zugehöriger Sockets
und Socket-Handshake-Authentifizierung gehören zu T006. T009 integriert den Spielstart separat; T005
erzeugt weder Start-Intents noch Engine-/Session-State. Gemeinsame Rate-Limit-Verwaltung für mehrere
Backend-Instanzen ist kein MVP-Verteilungsschritt und bleibt einer späteren Betriebsentscheidung
vorbehalten.
