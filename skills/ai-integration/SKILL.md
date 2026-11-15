---
name: AI Integration
description: Für serverseitige LLM-Adapter, kontrollierte Charakterdialoge, Prompts, Ausgabevalidierung, Timeouts und Kostenlimits verwenden.
---

# Skill: AI Integration

## Ziel
Optionale Charakterdialoge mit kontrolliertem Wissen, strukturierten Ergebnissen und begrenzten Kosten ergänzen den vollständig ohne KI spielbaren Katalogdialog.

## Ablauf
1. Engine prüft die Katalogfrage und bestimmt Referenzantwort, freigegebenen Wissenskontext sowie deterministische Zustandsänderungen.
2. Ohne aktivierten Provider verwendet der Dialogue-Use-Case die Referenzantwort; kein Provider wird aufgerufen.
3. Mit aktiviertem Provider erstellt das Backend einen minimierten Prompt aus versionierten Templates und freigegebenem Kontext.
4. Der Provider-Adapter sendet die Anfrage mit Timeout und Budget; die Antwort wird gegen ein Zod-Schema validiert.
5. Ungültige Antworten oder Providerfehler führen auf eine bereits angenommene Katalogfrage zur Referenzantwort, nicht zu einem neuen Engine-Ergebnis und nicht zu einem erzwungenen Retry.
6. Antwort und Engine-Ereignis werden autorisiert und genau einmal persistiert, bevor sie berechtigte Empfänger erreichen.

## Antwortvertrag

Verbindlich ist der serverseitige `DialogueProvider`-Union in `specs/ai-suspects.md`. Die eigentliche Modellausgabe ist ausschließlich ein striktes `{ dialogue: string }` mit 1–4000 Zeichen. Zusatzfelder, `mood`, `suggestedIntent`, `safetyFlags`, IDs, Hinweise, Bewertung, Phasen oder State-Patches erzeugen `invalid_output` und niemals eine Engine-Auswertung. Es gibt höchstens einen Adapteraufruf pro Use-Case-Ausführung, kein automatisches Retry/Backoff, standardmäßig 5 Sekunden Timeout und 600 Output-Tokens; der Katalog verwendet danach den Referenzfallback. Zusammengeführte in-flight Requests und erfolgreiche Receipt-Replays rufen nicht erneut auf; eine spätere Ausführung ohne Receipt darf erneut aufrufen und wird erneut auf das Budget angerechnet.

Der Freitextweg hat einen diskriminierten separaten Vertrag, nutzt `referenceAnswer = null`, bleibt actor-only und ist für den Fallabschluss nicht erforderlich. Scheitert er, lautet die öffentliche Antwort `AI_UNAVAILABLE`. Ohne Providerkonfiguration wird der Provider-Port nicht aufgerufen.

## Regeln
- Modell kennt nicht automatisch die gesamte Falllösung.
- Keine Engine- oder Datenbank-Tools an das Modell geben.
- Keine Geheimnisse oder private Hinweise anderer Spieler in Prompts.
- Keine Modellantwort ungeprüft als Wahrheit speichern.
- Katalogaktionen erzeugen mit und ohne Provider identische kanonische Hinweise, Phasen und Bewertungen.
- Keine automatischen Provider-Retries oder erforderlichen KI-Kosten für den Basismodus. Das T009-Dialogue-/Game-Session-Repository reserviert atomar höchstens 60 Versuche über beide Modi vor jeder Providerausführung; der T008-Adapter besitzt dieses Budget nicht. Erschöpftes Budget ruft nicht mehr auf: Katalog nutzt Referenzfallback, Freitext `AI_UNAVAILABLE`.
- Tests verwenden Mocks und Fixtures; zusätzlich wird der Basismodus mit null Provideraufrufen geprüft.
