---
name: Testing
description: Für Unit-, Integrations-, Playwright-E2E-, Sicherheits- und Regressionstests mit kontrollierten externen Abhängigkeiten verwenden.
---

# Skill: Testing

## Testpyramide
- Viele schnelle Unit-Tests für reine Game-Engine-Regeln.
- Integrationstests für API, Persistenz und Socket-Autorisierung.
- Wenige stabile Playwright-E2E-Tests für kritische User Journeys.

## Regeln
- Zeit, Zufall und externe Provider mocken oder injizieren.
- KI-Tests nutzen feste Provider-Fixtures, keine Live-API.
- Teste auch Ablehnungen und Fehlersituationen.
- Jeder Bugfix erhält einen Regressionstest.
- Tests dürfen keine produktiven Daten oder Secrets benötigen.
