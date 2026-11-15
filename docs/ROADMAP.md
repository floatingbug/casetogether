# MVP-Roadmap

Die Zeitangaben sind grobe Planungshypothesen für einen erfahrenen Einzelentwickler mit Agentenunterstützung. Parallelisierung spart nicht automatisch Kalenderzeit; Integration und Tests benötigen Zeit.

## Gate 0 – Produkt- und Architektur-Freeze
Ergebnis: MVP-Scope, Datenklassifikation, API-/Socket-Verträge und Task-Ownership freigegeben.
Exit: keine offenen Blocker für Grundgerüst und parallele Arbeit.

## Gate 1 – Repository und technische Basis
Ergebnis: pnpm-Monorepo, TypeScript, Lint, Tests, CI, Frontend und Backend starten lokal.
Exit: CI grün; Health Endpoint erreichbar.

## Gate 2 – Identität und Räume
Ergebnis: Nutzer können sich anmelden, privaten Raum erstellen und beitreten.
Exit: Berechtigungs- und Negativtests grün.

## Gate 3 – Realtime-Grundlage
Ergebnis: Mitglieder sehen Präsenz, Chat und Raumereignisse; Reconnect funktioniert.
Exit: zwei Browser-Kontexte bleiben synchron; keine fremden Raumdaten sichtbar.

## Gate 4 – Deterministische Game Engine
Ergebnis: ein vollständiger Fall mit Zustandsübergängen, Hinweisen und Lösung.
Exit: Engine-Tests decken alle gültigen und ungültigen Übergänge ab.

## Gate 5 – KI-Dialoge
Ergebnis: Verdächtige antworten kontextbezogen, begrenzt und kontrolliert.
Exit: Mock-Tests, Timeout-/Fehlerfälle, Kostenlimits und Prompt-Injection-Tests vorhanden.

## Gate 6 – Durchgängiger Spielablauf
Ergebnis: Host startet Fall, Gruppe ermittelt und reicht Lösung ein.
Exit: Playwright-E2E für vollständigen Ablauf grün.

## Gate 7 – Testgruppen und MVP-Härtung
Ergebnis: UX, Performance, Logging, Datenschutzunterlagen und Betriebsabläufe geprüft.
Exit: mehrere externe Testgruppen können ohne manuelle Entwicklerhilfe spielen.

## Nicht in MVP-Gates
Creator Marketplace, Abos, Voice, öffentliche Matchmaking-Lobby, UGC-Editor. Diese Themen erst nach Validierung des Kernloops planen.
