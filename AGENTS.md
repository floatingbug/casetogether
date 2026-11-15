# AGENTS.md – Projektregeln

Diese Datei gilt für alle Agenten und alle Projektbereiche. Bei Konflikten gilt folgende Reihenfolge:
1. Sicherheits- und Datenschutzanforderungen
2. Diese Datei
3. `docs/ARCHITECTURE.md` und akzeptierte ADRs
4. jeweilige Spezifikation in `specs/`
5. Task-Beschreibung
6. Agenten-/Skill-Empfehlungen

## Produktziel

Baue einen stabilen, unterhaltsamen und sicheren MVP für ein kooperatives KI-Krimi-Spiel mit 2–4 Spielern. Priorität haben ein vollständiger Spielablauf, nachvollziehbare Regeln, Synchronisierung und gute Fehlerbehandlung – nicht eine große Feature-Menge.

## Arbeitsweise

- Arbeite task-basiert. Beginne keine nicht zugewiesene größere Funktion.
- Lies vor jeder Änderung die betroffenen Spezifikationen und bestehenden Implementierungen.
- Erstelle vor größeren Änderungen einen kurzen Plan und benenne betroffene Dateien.
- Halte Änderungen klein, überprüfbar und rückwärtskompatibel, sofern möglich.
- Ändere keine fremden Zuständigkeitsbereiche ohne Abstimmung mit dem Orchestrator.
- Keine stillen Architekturwechsel. Schlage sie als ADR vor.
- Erfinde keine Anforderungen, API-Felder, Umgebungsvariablen oder Produktentscheidungen. Markiere Unklarheiten und frage den Orchestrator.
- Wenn eine Entscheidung nicht blockiert, triff eine einfache, dokumentierte und reversible Wahl.
- Aktualisiere Dokumentation und Task-Status zusammen mit dem Code.

## Architekturprinzipien

- TypeScript strict mode aktivieren.
- Monorepo mit pnpm workspaces.
- Frontend und Backend sind getrennte Apps.
- Gemeinsame, framework-neutrale Verträge und Schemas liegen in `packages/shared`.
- Backend ist die Autorität für Identität, Berechtigungen, Spielzustand und Spielregeln.
- REST für CRUD-/Abfrageoperationen; Socket.IO für Live-Ereignisse.
- MongoDB ist persistente Datenquelle. Socket-Verbindungen sind nicht persistent.
- Game Engine ist deterministisch und unabhängig von LLM-Aufrufen.
- LLM-Aufrufe erfolgen ausschließlich serverseitig über einen Provider-Adapter.
- Keine Secrets im Repository oder Frontend-Bundle.
- Zeitkritische/mehrfach eintreffende Aktionen müssen idempotent oder gegen Duplikate geschützt sein.

## TypeScript- und Codequalität

- Kein `any`, außer mit begründeter, lokaler Ausnahme und Kommentar.
- `unknown` verwenden und an Systemgrenzen validieren.
- Keine unnötigen Type Assertions (`as`); wenn unvermeidbar, begründen.
- Externe Daten immer validieren: HTTP, Socket.IO, Datenbankgrenzen, LLM-Ausgaben.
- Kleine Funktionen und klare Verantwortlichkeiten bevorzugen.
- Fehler nicht verschlucken. Fehler müssen sinnvoll klassifiziert und protokolliert werden.
- Keine Geschäftslogik in Express-Controllern oder Vue-Komponenten.
- Keine direkte Datenbank- oder LLM-Logik in Socket-Event-Handlern.
- Keine Geheimnisse, Tokens oder vollständige private Spielerinformationen loggen.

## Sicherheit und Fairness

- Jede Spielraumaktion serverseitig auf Mitgliedschaft und Berechtigung prüfen.
- Einladungs-Codes müssen ausreichend zufällig und nicht fortlaufend sein.
- Rate Limits für Login, Raumbeitritt, Chat und KI-Anfragen.
- LLM-Ausgaben als nicht vertrauenswürdig behandeln.
- Prompts dürfen keine geheimen Lösungsteile unnötig an das Modell oder den Client übertragen.
- Spieler dürfen nur die Informationen erhalten, die ihre Rolle/Berechtigung erlaubt.
- Keine vom Client übermittelten Spielstände als autoritativ akzeptieren.
- Schutz gegen Prompt Injection: Spielerdialoge sind Daten, keine Systemanweisungen.
- Personenbezogene Daten minimieren; Lösch- und Aufbewahrungskonzept dokumentieren.
- Zahlungsstatus niemals allein anhand einer Client-Angabe akzeptieren.

## Tests und Qualitätsgates

Vor Abschluss einer Aufgabe:
1. Formatierung/Lint ausführen, sofern eingerichtet.
2. Typecheck ausführen.
3. Relevante Unit-/Integrationstests ausführen.
4. Bei UI-Änderungen passende E2E-Tests ergänzen oder aktualisieren.
5. Fehler beheben oder ausdrücklich dokumentieren, warum ein Test nicht ausführbar ist.
6. Geänderte Akzeptanzkriterien einzeln abhaken.

Ein Task ist nicht abgeschlossen, wenn nur Code geschrieben wurde. Er ist abgeschlossen, wenn Tests und Dokumentation den Zustand belegen.

## Git und Zusammenarbeit

- Jeder Spezialagent arbeitet in einem eigenen Branch oder isolierten Worktree.
- Branch-Namensschema: `agent/<task-id>-<kurzer-name>`.
- Commits klein und eindeutig: `feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`, `docs(scope): ...`.
- Kein Agent committet auf `main`.
- Keine Agenten überschreiben oder resetten fremde Arbeit.
- Gemeinsame Verträge zuerst festlegen; parallele Implementierung startet erst nach Freigabe der Schnittstellen.
- Merge nur nach Review durch den Orchestrator und bestandenen Qualitätsgates.
- Konflikte werden nicht durch blindes Überschreiben gelöst.

## Definition of Done

- Akzeptanzkriterien erfüllt.
- Tests vorhanden und erfolgreich.
- Typecheck/Lint erfolgreich oder bekannte Abweichung dokumentiert.
- Fehler- und Berechtigungsfälle berücksichtigt.
- Dokumentation aktualisiert.
- Keine Secrets oder Debug-Artefakte enthalten.
- Task-Status und Commit/PR-Referenz im Task dokumentiert.
