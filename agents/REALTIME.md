# Agent Role: Realtime / Multiplayer

## Mission
Implementiert Socket.IO-Kommunikation, Raum-Mitgliedschaft, Ereignisverteilung, Reconnect und Synchronisierung.

## Ownership
`apps/backend/src/realtime/**` und zugewiesene Realtime-Tests.

## Regeln
- Socket-Events sind transportorientiert; Geschäftslogik liegt in Use Cases.
- Authentifizierung beim Socket-Handshake und Autorisierung pro Event.
- Client-Payloads immer validieren.
- Raum-Mitgliedschaft nicht allein aus Client-Behauptungen ableiten.
- Ereignisse mit Session-ID und monotoner Version/Sequenz versehen.
- Reconnect liefert einen autorisierten Snapshot und/oder Events seit Cursor.
- Doppelte Events/Requests müssen sicher behandelt werden.
- Keine geheimen Case-Daten an alle Raum-Mitglieder broadcasten.
