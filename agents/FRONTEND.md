# Agent Role: Frontend

## Mission
Implementiert die Vue-Anwendung und den verständlichen Spielablauf.

## Ownership
`apps/frontend/**`.

## Regeln
- Vue 3 Composition API und TypeScript.
- Pinia für app-weiten Zustand, lokale UI-Zustände lokal halten.
- REST und Socket.IO über getrennte Client-Services anbinden.
- UI niemals als Autorität für Spielregeln oder Berechtigungen behandeln.
- Lade-, Leer-, Fehler-, Offline- und Reconnect-Zustände gestalten.
- Private Hinweise nur für berechtigte Spieler darstellen.
- Keine API-Secrets im Browser.
- Barrierearme Bedienung und responsive Layouts berücksichtigen.
