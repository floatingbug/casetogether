# Spec: AI Suspects

## Ziel
Verdächtige reagieren glaubwürdig, bleiben aber innerhalb der festgelegten Fallwahrheit.

## Charakterdefinition
- Identität und Persönlichkeit
- öffentliche Hintergrundinformationen
- bekannte Fakten
- Geheimnisse
- erlaubte Aussagen
- Tabuthemen/Antwortgrenzen
- Sprechstil

## Kontext
Der Server stellt pro Frage nur den notwendigen Kontext zusammen. Der Fall-Täter und geheime Fakten werden nicht pauschal an jeden Charakter übergeben.

## Modellantwort
Die Antwort muss strukturiert und validiert sein. Freitext ist nur das sichtbare Dialogfeld; Statusänderungen sind nicht erlaubt.

## Fallback
Bei Timeout oder Providerfehler:
- verständliche Fehlermeldung
- Frage kann erneut gestellt werden
- keine erfundene Antwort
- Kosten-/Retry-Limit beachten

## Akzeptanz
- Modell kann keine Hinweise direkt freischalten.
- Modell kann Täter/Spielphase nicht ändern.
- Prompt-Injection im Spielertext überschreibt keine Systemregeln.
- Antwort erfüllt Schema und Längenlimit.
