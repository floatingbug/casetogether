---
name: AI Integration
description: Für serverseitige LLM-Adapter, kontrollierte Charakterdialoge, Prompts, Ausgabevalidierung, Timeouts und Kostenlimits verwenden.
---

# Skill: AI Integration

## Ziel
Charakterdialoge mit kontrolliertem Wissen, strukturierten Ergebnissen und begrenzten Kosten.

## Ablauf
1. Engine bestimmt Charakter und freigegebenen Wissenskontext.
2. Backend erstellt minimierten Prompt aus versionierten Templates.
3. Provider-Adapter sendet Anfrage mit Timeout und Budget.
4. Antwort wird gegen Zod-Schema validiert.
5. Anwendung prüft Ausgabe und verwirft unzulässige Aktionsvorschläge.
6. Nur erlaubte Dialogantwort wird persistiert und broadcastet.

## Antwortvertrag (Vorschlag)
- `dialogue`: sichtbarer Text
- `mood`: kontrollierter Enum-Wert
- `suggestedIntent`: optionaler Vorschlag, niemals direkte Zustandsänderung
- `safetyFlags`: kontrollierte Flags

## Regeln
- Modell kennt nicht automatisch die gesamte Falllösung.
- Keine Engine- oder Datenbank-Tools an das Modell geben.
- Keine Geheimnisse oder private Hinweise anderer Spieler in Prompts.
- Keine Modellantwort ungeprüft als Wahrheit speichern.
- Keine unbegrenzten Retry-Schleifen.
- Bei ungültiger Antwort begrenzte Wiederholung oder kontrollierter Fehler.
