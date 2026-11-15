# Datenmodell – Startentwurf

Das Modell ist ein Startpunkt und muss im Rahmen der Tasks mit Zugriffsmustern und Sicherheitsgrenzen validiert werden.

## Collections

### users
- `_id`
- `emailNormalized`
- `passwordHash` oder externer Identity-Provider-Identifier
- `displayName`
- `createdAt`, `updatedAt`

### cases
- `_id`, `slug`, `title`, `description`
- `version`, `status`
- `suspects[]` (Charakter-Metadaten und Referenzen)
- `clues[]` (Regel-IDs und Sichtbarkeitsregeln)
- `solution` (server-only)
- `createdAt`, `updatedAt`

Hinweis: Fallinhalte und Geheimnisse niemals unselektiert an Clients serialisieren.

### rooms
- `_id`, `codeHash`, `hostUserId`
- `status`, `memberUserIds[]`, `maxPlayers`
- `expiresAt`, `createdAt`

### gameSessions
- `_id`, `roomId`, `caseId`, `caseVersion`
- `status`, `phase`, `version`
- `memberStates[]`
- `discoveredClueIds[]`
- `finalSubmission`, `result`
- `startedAt`, `finishedAt`, `updatedAt`

### gameEvents
- `_id`, `sessionId`, `eventId`, `version`, `type`
- `actorUserId`, `payloadPublic`
- `createdAt`

### messages
- `_id`, `sessionId`, `senderType`, `senderId`
- `visibility`, `content`, `createdAt`
- `clientRequestId` (bei geeigneten Aktionen)

## Indizes – zu prüfen und anzulegen
- users: unique `emailNormalized`
- rooms: unique `codeHash`; TTL auf `expiresAt` nur falls fachlich passend
- gameSessions: `roomId`, `status`
- gameEvents: unique `(sessionId, eventId)` und/oder `(sessionId, version)`
- messages: `(sessionId, createdAt)`

## Datenklassifikation
- Public: Raumname, Spieler-Displaynamen, öffentliche Hinweise, freigegebene Dialoge
- Player-private: private Hinweise, persönliche Rolleninformationen
- Server-secret: Täter, vollständige Wahrheit, nicht freigegebene Geheimnisse, geheime Trigger

Client-DTOs müssen diese Trennung technisch erzwingen.
