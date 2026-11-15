# Produktdefinition

## Arbeitstitel
CaseTogether (vorläufig; Marken-/Domainprüfung offen).

## Produktvision
Freunde lösen gemeinsam interaktive Mystery- und Kriminalfälle. Jeder Spieler kann Verdächtige befragen, Informationen sammeln und mit der Gruppe diskutieren. Ein kuratierter Fragenkatalog mit fest geschriebenen Dialogen macht jeden Fall vollständig ohne KI spielbar; optionale KI-Charaktere können Dialoge zusätzlich lebendiger formulieren. Eine deterministische Game Engine sorgt dafür, dass die Geschichte fair und lösbar bleibt.

## Zielgruppe
- Freundesgruppen, Paare und kleine private Gruppen
- Menschen, die kooperative Rätsel, Krimis, Escape Rooms und Social Games mögen
- Primärer MVP-Fokus: deutschsprachige Spieler; Internationalisierung später

## Kernversprechen
„Ein gemeinsamer Kriminalfall, bei dem eure Fragen und Entscheidungen den Ermittlungsweg prägen.“

## MVP-Spielablauf
1. Host meldet sich an und erstellt privaten Raum.
2. System erzeugt Einladungslink/-code.
3. 2–4 Spieler treten bei.
4. Host startet einen fest definierten Fall.
5. Gruppe sieht Fallintro und Ermittlungsübersicht.
6. Spieler wählen Verdächtige und deren freigegebene Katalogfragen aus.
7. Der Verdächtige antwortet mit einer fest gepflegten Referenzantwort oder einer optionalen, regelkonformen KI-Formulierung.
8. Game Engine schaltet Hinweise unabhängig vom Provider aufgrund der ausgewählten Katalogfragen und definierter Bedingungen frei.
9. Gruppe diskutiert und gibt eine gemeinsame Lösung ab.
10. System zeigt Auflösung, Bewertung und Abschluss.

Der gesamte Ablauf funktioniert ohne LLM, API-Schlüssel und KI-Kosten. Private Multiplayer-Räume, Backend und MongoDB bleiben erforderlich. Fehlt ein optionaler KI-Provider oder schlägt er fehl, verwendet das Spiel die vorhandene Referenzantwort.

## MVP-Inhalt
- Ein vollständiger Kriminalfall
- Drei Verdächtige mit einem vollständig spielbaren, kuratierten Fragenkatalog und Referenzantworten
- Vier Spieler maximal
- Ein privater Raum
- Textbasierte Interaktion ohne zwingende Freitexterkennung
- Gemeinsamer Spielzustand und Chat
- Ein gemeinsames finales Urteil
- Optionale KI-Dialogformulierung ohne Zustandsautorität
- Desktop-first, responsive für Tablet/Mobil

## Nicht im MVP
- Creator-Editor/Marketplace
- Nutzer-generierte Fälle
- Voice-/Videochat
- Öffentliche Lobby und Matchmaking
- Freundeslisten und umfangreiche Social Graph
- Avatare/virtuelle Welt
- Mehrere Sprachen
- Echtzeit-Action/Physik
- Mobile Native Apps
- Serverloser Offline-Singleplayer-Modus
- Für den Fallabschluss erforderliche Freitext- oder KI-Erkennung
- Abo-/Payment-System vor validiertem Spielspaß

## Erfolgssignale für den MVP
Diese Werte sind Hypothesen, keine Branchenbenchmarks:
- Gruppen können ohne Entwicklerhilfe und ohne KI-Konfiguration einen Fall starten und beenden.
- Mindestens 70 % der gestarteten Sessions erreichen die Auflösung, unabhängig davon, ob die optionale KI aktiviert ist.
- Spieler verstehen, wie sie über Katalogfragen Hinweise sammeln und Verdächtige befragen.
- Ein Teil der Testgruppen möchte einen weiteren Fall spielen.
- Sofern KI aktiviert ist, sind ihre Kosten pro abgeschlossener Session messbar und wirtschaftlich begrenzbar.

## Monetarisierungshypothese
Zunächst kostenloser Testfall und qualitative Zahlungsbereitschaftstests. Danach Einzel-Fallkäufe; Abo erst prüfen, wenn wiederkehrende Nutzung nachgewiesen ist. Preise nicht als fest beschlossen behandeln.

## Produktprinzipien
- Vollständige Lösbarkeit ohne KI vor dynamischer Dialogfreiheit
- Gruppeninteraktion vor Solo-Chat
- Fairness und Lösbarkeit vor maximaler KI-Freiheit
- Kurze Wartezeiten und klare Rückmeldungen
- Privatsphäre und sichere Spielräume
- Wiederholbarkeit durch unterschiedliche Ermittlungswege, nicht durch zufällige Täter
