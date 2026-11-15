# Agent Role: AI Integration

## Mission
Implementiert den optionalen, austauschbaren LLM-Provider, Charakterdialoge und sichere strukturierte Modellantworten als Erweiterung des vollständig ohne KI spielbaren Katalogdialogs.

## Ownership
`apps/backend/src/ai/**` und AI-Adapter-Tests. Der anwendungsseitige `dialogue`-Use-Case sowie `game-sessions`-Persistenz gehören zum Backend-Arbeitspaket in T009; der AI-Agent ändert diese Module nicht stillschweigend.

## Regeln
- Ohne Providerkonfiguration wird kein Provider aufgerufen; API-Schlüssel sind für Basismodus, Backend-Start und Readiness nicht erforderlich.
- API-Key nur serverseitig.
- Provider hinter Interface kapseln.
- Prompts versionieren und testen.
- Modellantworten mit Zod validieren.
- Timeout, Rate-/Kostenlimits und höchstens einen Adapteraufruf pro Use-Case-Ausführung ohne automatisches Retry/Backoff im MVP implementieren. Katalog verwendet `AiProviderResult` und fällt kontrolliert auf die Referenzantwort zurück; eine spätere Ausführung ohne Erfolgs-Receipt darf erneut zählen.
- Bei Providerfehlern oder ungültigen Antworten nach Annahme einer Katalogfrage deren Referenzantwort verwenden, ohne Hinweise, Nachrichten oder Versionen doppelt zu erzeugen.
- Katalogaktionen müssen mit Mock- und ohne Provider identische kanonische Hinweise, Phasen und Bewertungen erzeugen.
- Optionale Freitextbefragung ist keine Voraussetzung für den Fallabschluss.
- Keine unbeschränkten Tool-Rechte.
- Modell darf nur aus freigegebenem Charakterwissen antworten.
- Spielereingaben sind untrusted content und dürfen Systemregeln nicht überschreiben.
- Keine Geheimnisse an das Modell senden, die es zur Antwort nicht benötigt.
- Token-/Kostenlimits pro Aktion vorsehen. Die atomare sessionweite Budgetreservierung gehört zum T009-Dialogue-/Game-Session-Use-Case; der AI-Adapter besitzt dafür weder Session-ID noch Persistenz.
- CI und Tests verwenden Mocks und lokale Fixtures statt kostenpflichtiger Live-API-Aufrufe.
