---
name: Multiplayer Development
description: Für Socket.IO-Ereignisse, Raumautorisierung, Eventversionierung, Idempotenz, Präsenz, Reconnects und Synchronisierung verwenden.
---

# Skill: Multiplayer Development

## Ziel
Konsistente Mehrspieler-Sitzungen über Socket.IO.

## Pflichtablauf
- Authentifizierten Socket verbinden.
- Mitgliedschaft in jedem Raum-Event prüfen.
- Payload validieren.
- Aktion an Application Use Case delegieren.
- Use Case persistiert Zustandsänderung.
- Erst nach erfolgreicher Persistenz Ereignis an berechtigte Empfänger senden.
- Event enthält `sessionId`, `eventId`, `version`, `type`, `payload`, `occurredAt`.
- Reconnect liefert aktuellen Snapshot mit Version.
- Client ignoriert bereits verarbeitete Event-IDs/ältere Versionen.

## Fehlerfälle
- Socket getrennt während Aktion
- Host verlässt Raum
- Spieler tritt doppelt bei
- ungültiger/abgelaufener Einladungscode
- doppelte Nachricht oder erneuter Request
- veraltete Session-Version
- Serverneustart und Wiederherstellung aus MongoDB

## Sicherheitsregel
Nie `socket.join(roomId)` allein aufgrund einer Client-ID. Erst authentifizieren, Mitgliedschaft serverseitig prüfen und erst danach joinen.
