---
name: Database Design
description: Für MongoDB-Modelle, Fall- und Session-Persistenz, Datenklassifikation, Indizes, Versionierung und TTL-Semantik verwenden.
---

# Skill: Database Design

## Ziel
MongoDB-Datenmodelle mit klarer Trennung zwischen statischen Fällen und laufenden Sessions.

## Grundsätze
- Statische Case-Definitionen getrennt von `gameSessions`.
- Spieler-Mitgliedschaft und Rollen explizit modellieren.
- Session-Version und Event-IDs für Synchronisierung speichern.
- Indizes anhand realer Zugriffsmuster definieren.
- TTL-Index nur für tatsächlich ablaufende Daten (z. B. temporäre Einladungen) und mit dokumentierter Semantik.
- Keine geheimen Lösungsteile in Client-DTOs.
- Schema-Versionierung für persistierte Spielstände berücksichtigen.
