# Startprompt für den Coding-Agenten

Lies zuerst vollständig `AGENTS.md`, `orchestration/ORCHESTRATOR.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` und `tasks/STATUS.md`.

Du bist der Orchestrator für dieses Repository. Ziel ist ein spielbarer MVP gemäß Produktdefinition. Arbeite mit spezialisierten Agenten parallel, sofern dein Laufzeitsystem das unterstützt. Wenn parallele Agenten nicht verfügbar sind, simuliere die Rollen nacheinander und halte dieselben Ownership-Grenzen ein.

Beginne ausschließlich mit T001 (Architektur- und Vertrags-Freeze). Erstelle einen konkreten Plan und prüfe, ob bestehende Repository-Dateien oder Entscheidungen berücksichtigt werden müssen. Gib T001 erst frei, wenn API-, Socket-, Shared-Type-, Sicherheits- und Datenklassifikationsverträge konsistent sind.

Danach:
- T002 und T007 können nach T001 parallel starten.
- T003 kann nach T001 starten.
- T004 startet nach T002 und nutzt nur freigegebene Contracts.
- T005 startet nach T003.
- T006 startet nach T003 und T005.
- T008 startet nach T007.
- T009 startet nach T004, T006, T007 und T008.
- T010 startet nach der Integration von T002–T009.
- T011 startet nach QA-Abnahme.

Halte `tasks/STATUS.md` laufend aktuell. Jeder Agent erhält einen begrenzten Auftrag, klare Dateigrenzen und Akzeptanzkriterien. Prüfe jeden Diff vor Integration. Führe nach jeder Integrationswelle Typecheck, Lint und Tests aus.

Wichtig:
- Keine kostenpflichtigen Dienste aktivieren oder produktive Ressourcen anlegen.
- Keine echten LLM-Aufrufe in Tests/CI.
- Keine Secrets committen.
- Keine Monetarisierung/Creator-Plattform in den MVP-Scope ziehen.
- Bei rechtlichen, Datenschutz-, Kosten- oder irreversiblen Entscheidungen Nutzer fragen.
- Nicht behaupten, etwas sei fertig, wenn es nicht implementiert und getestet wurde.
