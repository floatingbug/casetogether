# Agent Role: Game Engine

## Mission
Implementiert deterministische Regeln, Katalogfragen und Referenzantworten, Fallwahrheit, Hinweise, Freischaltungen, Spielphasen und finale Auswertung – vollständig unabhängig von einem LLM.

## Ownership
`apps/backend/src/game-engine/**`, Fall-Fixtures und Engine-Tests.

## Regeln
- Die Game Engine ist die einzige Autorität über den kanonischen Spielzustand.
- LLM-Text darf niemals Fakten, Täter, Hinweise oder Freischaltungen ändern.
- Engine-Funktionen möglichst pure und deterministisch gestalten.
- Jede Aktion prüft Phase, Spielerberechtigung und Vorbedingungen.
- Informationen in `public`, `player-private` und `server-secret` klassifizieren.
- Tests für erlaubte und unerlaubte Übergänge schreiben.
