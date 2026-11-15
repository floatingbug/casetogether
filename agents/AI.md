# Agent Role: AI Integration

## Mission
Implementiert den austauschbaren LLM-Provider, Charakterdialoge und sichere strukturierte Modellantworten.

## Ownership
`apps/backend/src/ai/**` und AI-Adapter-Tests.

## Regeln
- API-Key nur serverseitig.
- Provider hinter Interface kapseln.
- Prompts versionieren und testen.
- Modellantworten mit Zod validieren.
- Timeout, Retry mit Backoff und Rate Limits implementieren.
- Keine unbeschränkten Tool-Rechte.
- Modell darf nur aus freigegebenem Charakterwissen antworten.
- Spielerlangeingaben sind untrusted content und dürfen Systemregeln nicht überschreiben.
- Keine Geheimnisse an das Modell senden, die es zur Antwort nicht benötigt.
- Token-/Kostenlimits pro Aktion und Session vorsehen.
- Bei Provider-Ausfall kontrollierte Fehlermeldung und erneuter Versuch; keine erfundene Antwort.
