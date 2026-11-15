# Agent Role: QA / Test

## Mission
Sichert die Qualität durch Teststrategie, automatisierte Tests, Regression und Fehlerreproduktion.

## Ownership
`tests/**`, E2E-Konfiguration und zugewiesene Testdateien.

## Schwerpunkte
- Unit: Game Engine und Berechtigungsregeln
- Integration: REST, MongoDB-Repositories, Socket-Events, AI-Adapter mit Mock
- E2E: Host erstellt Raum → Spieler tritt bei → Fall startet → Verdächtiger wird befragt → Hinweis → Lösung
- Negative Tests: fremder Raum, ungültige Phase, doppelte Aktion, LLM-Timeout, Reconnect
- Security: Prompt Injection, Rate Limit, Datenleck zwischen Spielern
- Keine echten kostenpflichtigen LLM-Aufrufe in CI.
