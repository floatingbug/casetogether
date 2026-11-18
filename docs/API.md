# API-Konventionen und Endpunktübersicht

Die verbindlichen Schemas und Statuscodes des freigegebenen T001-Vertrags-Freeze stehen in `contracts/openapi.yaml`, die TypeScript-/Zod-Regeln in `contracts/shared-types.md`. Diese Übersicht erleichtert die Navigation und führt keine abweichenden DTOs ein.

## Allgemeine Konventionen

- Präfix `/api/v1`; JSON Request-/Response-Bodies; maximal 16 KiB pro JSON-/Socket-Anwendungspayload.
- Alle nicht leeren Erfolgsresponses sind `{ "data": T }`, Fehler sind `{ "error": ApiError }`.
- Öffentliche IDs sind opaque Strings; Server-Zeitstempel sind RFC 3339 in UTC.
- Auth erfolgt mit dem HttpOnly-Cookie `ct_session` gemäß ADR-002. Es gibt keine Bearer-Token-Alternative im Clientvertrag.
- Unsafe REST verlangt einen exakt zugelassenen `Origin` und `Content-Type: application/json`, sofern ein Body vorhanden ist. Cross-site `Sec-Fetch-Site` ist für die getrennten Vercel-/VPS-Origins erwartet (ADR-004).
- Authentifizierte Endpunkte sind in OpenAPI per `cookieAuth` markiert. Nicht sichtbare Ressourcen geben generisch `NOT_FOUND` zurück.
- `clientRequestId` ist eine UUID v4 für idempotente Raum-/Spielaktionen. `expectedVersion` schützt versionierte Mutationen.
- Listen ohne aktuelles Wachstum sind kleine vollständige Arrays; `recentMessages` ist auf 50 und Case-Listen auf 100 begrenzt. Neue Pagination erfordert eine Vertragserweiterung.
- Keine MongoDB-internen Dokumente oder beliebigen Persistenzobjekte als Response.

## REST-Endpunkte

| Methode/Pfad                                  | Auth         | Request                                           | Ergebnis                                                                                                                          |
| --------------------------------------------- | ------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                 | nein         | –                                                 | Prozess-Liveness, unabhängig von DB/Provider                                                                                      |
| `GET /ready`                                  | nein         | –                                                 | Readiness nur mit erforderlicher MongoDB; KI/Key kein Check                                                                       |
| `POST /auth/register`                         | nein         | E-Mail, Passwort 12–128, Anzeigename              | `201 PublicUser`, setzt Auth-Cookie                                                                                               |
| `POST /auth/login`                            | nein         | E-Mail, Passwort                                  | `200 PublicUser`, generischer `INVALID_CREDENTIALS`                                                                               |
| `POST /auth/logout`                           | optional     | –                                                 | `204`, revoziert und löscht Cookie; idempotent                                                                                    |
| `GET /me`                                     | ja           | –                                                 | aktueller `PublicUser`                                                                                                            |
| `POST /rooms`                                 | ja           | `clientRequestId`                                 | `201` initial `outcome = created` mit Code; identischer persistenter Replay `200 outcome = replayed, invitation = null` ohne Code |
| `POST /rooms/join`                            | ja           | `clientRequestId`, gruppierter Einladungscode     | `200 RoomSnapshot`; bestehendes Mitglied idempotent                                                                               |
| `GET /rooms/{roomId}`                         | Mitglied     | –                                                 | `200 RoomSnapshot`, niemals Code                                                                                                  |
| `POST /rooms/{roomId}/invitation/rotate`      | Host         | `clientRequestId`, `expectedVersion`              | initial `outcome = rotated` mit neuem Code; Replay `outcome = replayed, invitation = null`; nie Code im Receipt                   |
| `GET /cases`                                  | ja           | –                                                 | `{ items: CaseSummary[] }`, keine Antworten/Lösung                                                                                |
| `POST /rooms/{roomId}/start`                  | Host         | `clientRequestId`, `caseId`, `expectedVersion`    | `200 GameSnapshot`, Phase `investigating`                                                                                         |
| `GET /sessions/{sessionId}`                   | Raummitglied | –                                                 | empfängerspezifischer `GameSnapshot`                                                                                              |
| `POST /sessions/{sessionId}/final-submission` | Raummitglied | `clientRequestId`, `expectedVersion`, `suspectId` | `200 GameSnapshot`, atomar `completed` inklusive Ergebnis                                                                         |

Das Lobby-Verlassen und der Chat laufen über den unten dokumentierten authentifizierten Socket-Vertrag. Es gibt keinen Socket-Join per Einladungscode; dafür ist ausschließlich `POST /rooms/join` vorgesehen.

## Socket-Namenskonvention

Client → Server (jeweils mit Pflicht-Ack):

- `room:join`
- `room:sync`
- `room:leave`
- `chat:send`
- `suspect:question` mit diskriminiertem `mode: catalog | free_text`

Server → Client:

- `room:snapshot`
- `game:snapshot`
- `room:presence`
- `room:member-joined`
- `room:member-left`
- `room:closed`
- `room:invitation-rotated` (versioniert, ohne Code/Hash)
- `room:started`
- `chat:message`
- `game:event` mit diskriminierten Typen `game.started`, `suspect.answered`, `suspect.free_text_answered`, `game.completed`, `game.abandoned`
- `game:error`

Payloads, Ack-Shapes, Event-Hüllen, Versionssprünge, Handshakefehler (`connect_error.data.error`), Receipt-/Mitgliedschaftsausnahmen, Secret-Replays ohne Code und private Eventprojektion werden ausschließlich durch `contracts/events.md` ergänzt. Ein generisches `game:action` und ein separates unversioniertes `suspect:answer` gehören nicht zum freigegebenen MVP-Vertrag.

Der Basispfad von `suspect:question` verwendet `mode = catalog` sowie `questionId` und benötigt weder Freitext noch Provider/API-Schlüssel. Beide Pfade führen nur nach erfolgreicher Persistenz zu einer Antwort. Katalog-KI-Fehler erzeugen den Referenzfallback; Freitext-KI-Fehler erzeugen ausschließlich `AI_UNAVAILABLE` und blockieren den Katalogpfad nicht.
