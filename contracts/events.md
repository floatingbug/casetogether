# Realtime Event Contract Draft

Alle Payloads werden mit Zod validiert. Eventnamen und Felder sind vor paralleler Implementierung durch Architect zu finalisieren.

## Client → Server
### `room:join`
`{ roomCode: string }`

### `chat:send`
`{ sessionId: string, clientRequestId: string, content: string }`

### `suspect:question`
`{ sessionId: string, clientRequestId: string, suspectId: string, question: string }`

### `game:action`
`{ sessionId: string, clientRequestId: string, action: { type: string, ... } }`

## Server → Client
### `room:snapshot`
Aktueller, für den Empfänger bereinigter Snapshot mit `version`.

### `game:event`
Event-Hülle aus `specs/rooms-realtime.md`.

### `game:error`
`{ code: string, message: string, requestId?: string }`

## Regeln
- Keine internen Stacktraces an Clients.
- Keine geheimen Daten in Broadcasts.
- Jede mutierende Aktion braucht `clientRequestId`.
- Payloadgrößen und Stringlängen begrenzen.
