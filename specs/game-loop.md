# Spec: Core Game Loop

## Ziel
Eine Gruppe von 2–4 Spielern kann einen Fall gemeinsam abschließen.

## Zustände
- `waiting`: Raum wartet auf Host/Spieler
- `ready`: Fall und Spieler sind startbereit
- `investigating`: Befragung und Hinweise
- `submitted`: Lösung abgegeben
- `completed`: Auflösung angezeigt
- `abandoned`: Session abgebrochen/abgelaufen

## Regeln
- Nur Host darf den Fall starten.
- Start nur mit mindestens 2 und höchstens 4 Spielern.
- Fallversion wird beim Start fixiert.
- Täter und Lösung sind serverseitig geheim.
- Hinweise werden nur durch definierte Engine-Regeln freigeschaltet.
- Finale Abgabe ist eine gemeinsame Gruppenentscheidung im MVP.
- Abschluss ist idempotent.

## Akzeptanz
- Ungültige Zustandsübergänge werden abgelehnt.
- Zwei parallele Startaktionen erzeugen nicht zwei Sessions.
- Ein abgeschlossener Fall kann nicht erneut verändert werden.
