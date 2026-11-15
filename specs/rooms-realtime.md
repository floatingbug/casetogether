# Spec: Rooms & Realtime

## Anforderungen
- Private Räume mit zufälligem Einladungscode.
- 2–4 Mitglieder je Raum.
- Host-Rolle und Mitgliedschaft serverseitig.
- Raumbeitritt nur mit gültigem Code und freien Plätzen.
- Realtime-Präsenz und Gruppenchat.
- Reconnect mit aktuellem Snapshot.
- Socket-Events werden erst nach erfolgreicher Autorisierung angenommen.

## Event-Hülle
Jedes bestätigte Spielereignis nutzt eine Hülle:
- `eventId`: eindeutige ID
- `sessionId`: Session
- `version`: monoton steigende Session-Version
- `type`: Ereignistyp
- `payload`: typisierter Inhalt
- `occurredAt`: ISO-Zeitstempel

## Fehlerfälle
- Raum voll
- Code ungültig/abgelaufen
- Nutzer nicht Mitglied
- Host verlässt Raum
- Socket getrennt
- Event doppelt gesendet
- veraltete Version
