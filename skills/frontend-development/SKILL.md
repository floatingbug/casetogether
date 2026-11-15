---
name: Frontend Development
description: Für Vue-3-Komponenten, Pinia-Stores sowie typisierte REST- und Socket.IO-Clients in der CaseTogether-Oberfläche verwenden.
---

# Skill: Frontend Development

## Ziel
Vue-3-Oberfläche mit klaren Zuständen und typisierten API-/Realtime-Clients.

## Vorgehen
1. User Flow und API-/Socket-Verträge lesen.
2. View-Komponenten und wiederverwendbare UI-Komponenten trennen.
3. Services für REST und Socket.IO verwenden.
4. Pinia-Stores für gemeinsam genutzten Zustand definieren.
5. Lade-, Fehler-, Leer-, Offline- und Reconnect-Zustände implementieren.
6. Komponenten- und E2E-Tests ergänzen.

## Regeln
- Keine Businesslogik in Templates.
- Keine direkte `fetch`-Logik in Komponenten.
- Optimistische Updates nur mit sauberem Rollback.
- Serverantworten sind maßgeblich.
- Private Hinweise nicht in globale, ungeschützte Stores oder Logs schreiben.
