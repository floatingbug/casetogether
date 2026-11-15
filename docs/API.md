# API-Konventionen

Der genaue OpenAPI-Vertrag wird vor Implementierung in `contracts/openapi.yaml` festgelegt.

## Konventionen
- Präfix `/api/v1`
- JSON Request-/Response-Bodies
- Einheitliches Fehlerformat
- Authentifizierte Endpunkte explizit markieren
- IDs als Strings in öffentlichen DTOs
- Keine MongoDB-internen Dokumente direkt zurückgeben
- Pagination nur für Listen mit absehbarem Wachstum

## Vorläufige REST-Ressourcen
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /me`
- `POST /rooms`
- `POST /rooms/join`
- `GET /rooms/:roomId`
- `GET /cases`
- `POST /rooms/:roomId/start`
- `GET /sessions/:sessionId`
- `POST /sessions/:sessionId/final-submission`

## Socket-Namenskonvention
Client → Server:
- `room:join`
- `room:leave`
- `chat:send`
- `suspect:question`
- `game:action`

Server → Client:
- `room:snapshot`
- `room:member-joined`
- `room:member-left`
- `chat:message`
- `suspect:answer`
- `game:event`
- `game:error`

Diese Liste ist ein Entwurf, kein freigegebener Vertrag. Payloads und Fehlercodes müssen vor Implementierung in `contracts/` spezifiziert werden.
