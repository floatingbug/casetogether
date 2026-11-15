# KI-Multiplayer-Entertainment – Agent Kit

Vendor-neutrale Agenten-Konfiguration für die Entwicklung eines KI-gestützten Multiplayer-Krimi-/Mystery-Spiels.

## Ziel

Ein spielbarer MVP für 2–4 Freunde:
- Ein Host erstellt einen privaten Spielraum.
- Weitere Spieler treten per Einladungscode bei.
- Die Gruppe startet einen vordefinierten Kriminalfall.
- Spieler befragen Verdächtige über einen vollständig spielbaren, kuratierten Fragenkatalog; KI-Formulierungen sind optional.
- Die Game Engine verwaltet Wahrheit, Hinweise, Freischaltungen und Spielphasen deterministisch – unabhängig vom Provider.
- Alle Spieler sehen denselben freigegebenen Spielzustand.
- Am Ende gibt die Gruppe gemeinsam eine Lösung ab.

Der komplette Spielablauf funktioniert ohne LLM, API-Schlüssel und KI-Kosten. Private Multiplayer-Räume, Backend und MongoDB bleiben erforderlich; ein serverloser Offline-Modus ist nicht Teil des MVP.

**Nicht Ziel des MVP:** offene Creator-Plattform, öffentlicher Matchmaking-Modus, Voice-/Videochat, Echtzeit-Action, eigene KI-Modelle, Microservices oder mehrere parallel laufende Serverinstanzen.

## So verwendest du dieses Kit

1. Entpacke den Ordner in ein neues Git-Repository.
2. Lies `AGENTS.md` und `docs/PRODUCT.md`.
3. Öffne das Repository in deinem Coding-Agenten.
4. Weise einen Orchestrator-Agenten an, `orchestration/ORCHESTRATOR.md` zu befolgen.
5. Lass ihn die Aufgaben in `tasks/` anhand der Abhängigkeiten verteilen.
6. Jeder Spezialagent arbeitet nur in seinem festgelegten Zuständigkeitsbereich.
7. Integration erfolgt über den Orchestrator und die CI-Prüfungen.

Die Fach- und Rollendateien sind bewusst agenten- und herstellerneutral gehalten. Die Markdown-Dateien bleiben die maßgebliche Quelle. Für OpenCode V2 ist ein nativer Adapter unter `.opencode/` enthalten.

### OpenCode V2

1. Starte `opencode` im Projektstamm oder in einem vollständigen Projekt-Worktree.
2. Neue Sitzungen verwenden den Agenten `orchestrator`. Bestehende Sitzungen können `/orchestrate` verwenden, um ihn ausdrücklich auszuwählen.
3. `/orchestrate` prüft den tatsächlichen Projektstatus und beginnt bei einem neuen Projekt mit T001. Die Arbeit startet nicht allein durch Öffnen des Repositories.
4. Der Orchestrator verwendet die nativen Spezialagenten `backend`, `frontend`, `realtime`, `game-engine`, `ai`, `qa` und `devops` entsprechend den Taskabhängigkeiten.

Die Laufzeitregeln, Agentenabbildung und Worktree-Isolierung sind in `orchestration/OPENCODE.md` beschrieben. Modelle werden nicht projektseitig festgelegt. Git-Mutationen, Deployments und kostenpflichtige externe Aktionen benötigen eine ausdrückliche Freigabe.

## Technologieentscheidungen

- Frontend: Vue 3, TypeScript, Vite, Pinia, Vue Router
- Backend: Node.js, TypeScript, Express
- Echtzeit: Socket.IO
- Datenbank: MongoDB
- Validierung: Zod
- API-Vertrag: OpenAPI 3.1
- Tests: Vitest, Supertest, Playwright
- KI: optionaler, austauschbarer LLM-Provider-Adapter; initial OpenAI API; ohne Konfiguration wird kein Provider aufgerufen
- Monorepo: pnpm workspaces
- Deployment: zunächst ein Frontend-Host und ein Backend-Host; konkrete Anbieter nach Verfügbarkeit/Region auswählen

## Wichtige Leitentscheidung

Die KI ist **optional und nicht die Quelle der Wahrheit**. Jeder Fall kann allein mit Katalogfragen und fest gepflegten Referenzantworten abgeschlossen werden. Server und Game Engine besitzen den kanonischen Spielzustand. Ein Modell darf Dialoge formulieren und innerhalb eng definierter Grenzen Charakterverhalten darstellen. Es darf weder Täter noch Fakten, Hinweise, Berechtigungen oder Spielphasen verändern. Dieselbe Katalogaktion muss mit und ohne KI identische kanonische Hinweise, Folgefragen, Phasen und Bewertungen erzeugen. Optionale Freitext-KI ist separat, actor-only und nicht abschlussrelevant. Die Entscheidungen sind in `docs/adr/0001-ki-dialoge-optional.md` (Katalog), `docs/adr/0002-http-only-auth-sessions.md` (Auth) und `docs/adr/0003-idempotenz-versionierung-konsistenz.md` (Konsistenz) dokumentiert.

### Verträge

- `contracts/openapi.yaml`: konkrete REST-Operationen, Schemas, Cookie-Auth und Fehler
- `contracts/shared-types.md`: normative Shared-DTOs, Zod-Regeln, Sichtbarkeiten und Invarianten
- `contracts/events.md`: diskriminierte Socket-Requests/Acks, Eventhüllen, Reconnect und private Projektionen
- `docs/DATABASE.md`: Persistenz, Indizes, Datenklassifikation und technische Aufbewahrung

Der T001-Freeze wurde durch den Nutzer am 2026-11-15 ausdrücklich für die nachfolgende Umsetzung freigegeben; einzelne Folge-Tasks werden jeweils nach ihrer Abhängigkeits- und Freigabeprüfung gestartet. Die Markdown-/YAML-Verträge werden anschließend in T002 als TypeScript-/Zod-Contracts in `packages/shared` abgebildet.

## Verzeichnisübersicht

- `AGENTS.md`: globale Regeln
- `.opencode/`: native OpenCode-V2-Konfiguration, Agenten und Commands
- `orchestration/`: Koordination mehrerer Agenten
- `agents/`: maßgebliche Rollenbeschreibungen und Zuständigkeiten
- `skills/`: wiederverwendbare Spezialanweisungen
- `docs/`: Produkt-, Architektur-, Betriebsdokumentation und ADRs
- `specs/`: fachliche Spezifikationen
- `tasks/`: umsetzbare Tickets mit Akzeptanzkriterien
- `contracts/`: gemeinsame Schnittstellenkonventionen
- `templates/`: Vorlagen für neue Aufgaben und ADRs
