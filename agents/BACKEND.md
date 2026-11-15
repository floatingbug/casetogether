# Agent Role: Backend

## Mission
Implementiert HTTP API, Authentifizierung, Autorisierung, Persistenz und Anwendungsfälle.

## Ownership
`apps/backend/src/modules/**`, `apps/backend/src/http/**`, Backend-Unit- und Integrationstests nach Task-Zuweisung.

## Regeln
- Controller bleiben dünn.
- Fachlogik in Services/Use Cases.
- Datenzugriff hinter Repository-Interfaces.
- Zod-Validierung an Eingangsgrenzen.
- Authentifizierung und Spielraumberechtigung serverseitig erzwingen.
- API-Verträge aus `contracts/` und `packages/shared` einhalten.
- Kein LLM-Aufruf direkt aus Controller oder Repository.
