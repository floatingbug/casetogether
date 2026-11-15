# Native OpenCode-V2-Orchestrierung

Diese Datei beschreibt den OpenCode-Adapter für das vendor-neutral dokumentierte Agentenmodell. Maßgebliche Fach- und Projektregeln bleiben `AGENTS.md`, `agents/`, `orchestration/ORCHESTRATOR.md`, `orchestration/START_PROMPT.md`, `specs/`, `contracts/` und `tasks/`.

## Start

OpenCode wird im Projektstamm gestartet. Neue Sitzungen verwenden durch `.opencode/opencode.jsonc` den primären Agenten `orchestrator`. Eine bereits bestehende Sitzung behält gegebenenfalls ihren bisherigen Agenten; der Befehl `/orchestrate` wählt den Orchestrator ausdrücklich aus.

Das Öffnen des Repositories startet keine Arbeit automatisch. `/orchestrate` löst den Statuscheck und die Orchestrierung anhand `orchestration/START_PROMPT.md` aus. Bereits erledigte Arbeit wird nicht blind wiederholt. Es werden keine Modelle oder Provider durch das Projekt erzwungen: Primär- und Subagenten verwenden die vom Nutzer beziehungsweise Elternsession ausgewählte Modellkonfiguration.

Konfigurations-, Agenten-, Command- und Skill-Dateien werden von OpenCode beim Speichern neu geladen. Ein Neustart ist dafür nicht erforderlich.

## Agentenabbildung

| OpenCode-Agent | Modus | Maßgebliche Rolle |
|---|---|---|
| `orchestrator` | primär | `agents/ARCHITECT.md` und `orchestration/ORCHESTRATOR.md` |
| `backend` | Subagent | `agents/BACKEND.md` |
| `frontend` | Subagent | `agents/FRONTEND.md` |
| `realtime` | Subagent | `agents/REALTIME.md` |
| `game-engine` | Subagent | `agents/GAME_ENGINE.md` |
| `ai` | Subagent | `agents/AI.md` |
| `qa` | Subagent | `agents/QA.md` |
| `devops` | Subagent | `agents/DEVOPS.md` |

Nur der Orchestrator darf diese Spezialagenten starten. Eine neue Subagentensitzung besitzt frischen Kontext. Der Orchestrator übergibt deshalb mindestens:

- Task-ID und konkretes Ziel,
- aktuellen Status sowie relevante Entscheidungen,
- Pflichtlektüre und freigegebene Verträge,
- Ownership und verbotene Änderungsbereiche,
- Akzeptanzkriterien und verlangte Tests,
- erwartete Übergabe mit Dateien, Testbefehlen, Ergebnissen und Einschränkungen.

Fachagenten ändern zentrale Verträge oder fremde Bereiche nicht stillschweigend. Sie liefern dem Orchestrator einen Änderungsvorschlag beziehungsweise melden einen Blocker. Falls Task und Rollen-Ownership widersprüchlich sind, wird die Grenze vor der Änderung ausdrücklich geklärt.

## Worktree-Isolierung

Ein initialer Baseline-Commit ist Voraussetzung für Agenten-Branches und Worktrees. Arbeit an `main` ist nicht zulässig.

Für jeden schreibenden Fachauftrag gilt:

1. Der zugewiesene Agent prüft Task, Ownership und freigegebene Verträge, bevor er Dateien verändert.
2. Er erstellt mit dem nativen OpenCode-Worktree-Werkzeug einen eigenen Arbeitsbereich. Worktree und Branch folgen dem Task beziehungsweise dem Schema `agent/<task-id>-<kurzer-name>`.
3. Er verschiebt seine eigene Sitzung mit dem OpenCode-Session-Move-Werkzeug ohne `sessionID` in den zurückgegebenen Worktree-Pfad. Erst danach beginnt die schreibende Arbeit.
4. Alle Änderungen und Testläufe dieses Auftrags erfolgen in diesem Worktree. Neue Konfiguration und `AGENTS.md` gelten auch dort.
5. Die Übergabe nennt Worktree-Pfad, Branch, geänderte Dateien, Testbefehle und Ergebnisse. Der Orchestrator prüft den realen Diff und die Tests vor einer Integration.

Rein lesende Recherchen brauchen keinen Worktree, dürfen aber keine Projektdateien verändern. Falls die Laufzeit keine Worktree-/Session-Move-Werkzeuge bereitstellt oder der Baseline-Commit fehlt, meldet der Agent den Arbeitsauftrag als blockiert. Er weicht nicht ungefragt auf das gemeinsame Arbeitsverzeichnis aus. Schlägt das native Worktree-Werkzeug technisch fehl, prüft der Orchestrator den Zustand und darf nach ausdrücklicher Nutzerfreigabe einen äquivalenten `git worktree add`-Befehl für den vorgesehenen Task-Branch verwenden. Anschließend wird die Session mit dem nativen Move-Werkzeug in den verifizierten Worktree verschoben; das Fehlschlagen wird nicht durch blindes Wiederholen oder Arbeiten in `main` umgangen.

OpenCode legt Projekt-Worktrees unter `.worktrees/` ab; dieser Pfad ist von Git und vom Projekt-Watcher ausgenommen. Kein Agent committet, mergt, rebased, resettet oder pusht ohne ausdrückliche aktuelle Nutzerfreigabe. Die Integration erfolgt erst nach Review durch den Orchestrator und niemals als automatischer Commit auf `main`.

Ownership und Reviewpflichten bleiben auch mit Tool-Berechtigungen bestehen: Berechtigungen ersetzen weder die fachliche Prüfung noch einen vollständig sandboxten Shell-Prozess.

## Skills

Die bestehenden Skills unter `skills/` werden durch den Eintrag `./skills` in `.opencode/opencode.jsonc` registriert. Deshalb wird OpenCode im Projektstamm beziehungsweise in einem vollständigen Projekt-Worktree gestartet. Klare Frontmatter-Beschreibungen machen sie automatisch auffindbar; ein Agent lädt einen passenden Skill bei Bedarf mit dem Skill-Werkzeug.

| Skill-ID | Einsatz |
|---|---|
| `frontend-development` | Vue, Pinia, REST-/Socket-Clients |
| `backend-development` | Express, Use Cases, Repositories, Validierung |
| `multiplayer-development` | Socket.IO, Synchronisierung, Reconnects |
| `ai-integration` | Provider-Adapter, Prompts, kontrollierte Antworten |
| `database-design` | MongoDB, Persistenz, Indizes, Datenklassifikation |
| `testing` | Unit-, Integrations-, E2E- und Security-Tests |

Für Tests und CI gelten weiterhin Mock-Provider und lokale Fixtures. Es werden weder produktive Ressourcen noch kostenpflichtige Live-LLM-Aufrufe automatisch aktiviert.
