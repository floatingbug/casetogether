# MVP-Roadmap

Die Zeitangaben sind grobe Planungshypothesen für einen erfahrenen Einzelentwickler mit Agentenunterstützung. Parallelisierung spart nicht automatisch Kalenderzeit; Integration und Tests benötigen Zeit.

## Gate 0 – Produkt- und Architektur-Freeze
Ergebnis: MVP-Scope, Datenklassifikation, vollständig konkrete API-/Socket-/Zod-Referenzen und Task-Ownership. ADR-001 legt den providerunabhängigen Katalogpfad fest, ADR-002 die revozierbaren HttpOnly-Auth-Sessions und ADR-003 Idempotenz/Versionierung/Konsistenz.
Exit: T001-Prüfungen bestehen, keine internen Vertragsblocker; Nutzer gibt den Freeze für Grundgerüst und parallele Arbeit ausdrücklich frei.

## Gate 1 – Repository und technische Basis
Ergebnis: pnpm-Monorepo, TypeScript strict, Lint, Tests, CI, Frontend und Backend starten lokal; `packages/shared` bildet alle eingefrorenen DTO-/Zod-Schemas ab.
Exit: CI grün; Health/Readiness gemäß OpenAPI erreichbar; OpenAPI-/Referenzvalidierung läuft; kein Provider/API-Schlüssel erforderlich.

## Gate 2 – Identität und Räume
Ergebnis: Nutzer können sich mit revozierbarer HttpOnly-Session anmelden, privaten Raum erstellen/beitreten und Einladungen rotieren.
Exit: Auth-/Origin-/Revocation-, Idempotenz-, Versions-, Berechtigungs- und Negativtests grün; Codes nur gehasht und nie in Snapshots/Logs.

## Gate 3 – Realtime-Grundlage
Ergebnis: Mitglieder sehen Präsenz, Chat und Raumereignisse; Reconnect funktioniert.
Exit: zwei Browser-Kontexte bleiben synchron; keine fremden Raumdaten sichtbar.

## Gate 4 – Deterministische Game Engine und Basismodus
Ergebnis: ein vollständiger Fall mit Zustandsübergängen, kuratiertem Fragenkatalog, Referenzantworten, Hinweisen und Lösung – vollständig ohne Provider.
Exit: Engine-Tests decken alle gültigen und ungültigen Übergänge sowie alle für den Abschluss erforderlichen Katalogpfade ab.

## Gate 5 – Optionale KI-Dialoge
Ergebnis: Zusätzlich zum Basismodus können Verdächtige optional kontextbezogen per KI antworten, ohne kanonische Ergebnisse zu verändern; separater Freitextdialog bleibt actor-only und nicht abschlussrelevant.
Exit: Mock-Tests, Referenzfallback für Katalog-Timeout-/Fehlerfälle, Kostenlimits und Prompt-Injection-Tests vorhanden; Basismodus ruft keinen Provider auf, Freitext ohne Provider endet mit `AI_UNAVAILABLE` ohne Engine-Wirkung.

## Gate 6 – Durchgängiger Spielablauf
Ergebnis: Host startet Fall, Gruppe ermittelt über Katalogfragen und reicht Lösung ein, mit oder ohne optionale KI.
Exit: Playwright-E2E für den vollständigen Ablauf ist ohne API-Schlüssel und nachweislich ohne Provideraufrufe grün. Zusätzliche Mock-Tests belegen identische kanonische Hinweise, Phasen und Bewertungen bei Katalogaktionen.

## Gate 7 – Testgruppen und MVP-Härtung
Ergebnis: UX, Performance, Logging, Datenschutzunterlagen und Betriebsabläufe geprüft.
Exit: mehrere externe Testgruppen können ohne manuelle Entwicklerhilfe spielen. Zusätzlich sind rechtliche/Datenschutz-/Altersfreigabe-Fragen ausdrücklich bewertet, Konto-/Backup-Löschung sowie verwaiste Start-Session-Bereinigung geklärt und keine kostenpflichtigen/produktiven Ressourcen ohne Freigabe aktiviert.

## Nicht in MVP-Gates
Creator Marketplace, Abos, Voice, öffentliche Matchmaking-Lobby, UGC-Editor. Diese Themen erst nach Validierung des Kernloops planen.
