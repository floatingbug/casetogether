# ADR-001: Vollständiger Spielablauf ohne KI durch einen Fragenkatalog

- Status: Accepted (T001-Freeze, Nutzerfreigabe 2026-11-15)
- Datum: 2026-11-15
- Verantwortlich: Nutzer/Product Owner; technische Einordnung durch Architect

## Kontext

CaseTogether soll einer privaten Gruppe von 2–4 Spielern einen vollständigen Kriminalfall auch dann ermöglichen, wenn kein LLM konfiguriert ist. Dafür dürfen weder ein API-Schlüssel noch ein externer KI-Provider oder KI-Kosten erforderlich sein. Backend, MongoDB und autorisierte Multiplayer-Räume bleiben dagegen erforderlich; ein serverloser Offline-Singleplayer-Modus ist nicht Teil dieser Entscheidung.

Die Game Engine ist bereits als deterministische Autorität festgelegt. Bislang beschreiben Produkt und Datenfluss KI-Antworten aber als regulären Bestandteil der Befragung, und der Fehlerfall sieht lediglich einen erneuten Versuch vor. Damit ist das vollständige Spielen ohne Provider noch nicht sichergestellt.

Als Interaktion ohne KI wurde ein kuratierter Fragenkatalog ausgewählt. Dadurch müssen Spieler keine vom System erwartete Formulierung erraten.

## Entscheidung

1. Jeder Fall enthält alle für seine Lösbarkeit erforderlichen Katalogfragen mit stabilen `questionId`-Werten, zugehörigen Verdächtigen und fest geschriebenen Referenzantworten.
2. Die Engine bildet jede erlaubte `questionId` deterministisch auf Antwort, Hinweise, Folgefragen und sonstige erlaubte Zustandsänderungen ab. Alle für den Abschluss erforderlichen Aktionen sind als Katalogfragen verfügbar.
3. Der verbindliche Befragungsvertrag verwendet für Katalogfragen `suspectId` und `questionId`. Eine optionale Freitextbefragung wird separat vertraglich festgelegt und ist niemals Voraussetzung für den Fallabschluss.
4. Der Basismodus verwendet ausschließlich die Referenzantworten. Ohne konfigurierten Provider wird kein Provider aufgerufen; ein fehlender API-Schlüssel blockiert weder Backend-Start noch Readiness oder Spielzüge.
5. KI kann optional freigegebene Antworten formulieren oder erweitern. Sie erhält keine Zustandsautorität und darf keine Täter, Fakten, Hinweise, Berechtigungen oder Phasen bestimmen. Ihre Ausgaben bleiben untrusted und werden validiert.
6. Dieselbe Katalogaktion erzeugt mit und ohne KI dieselben kanonischen Hinweise, Phasen und Bewertungen. Modellantworten ändern dieses Ergebnis nicht.
7. Sofern eine Frage bereits eindeutig als Katalogaktion angenommen wurde, verwendet der Server bei Providerausfall, Timeout oder ungültiger Modellausgabe ihre vorhandene Referenzantwort. Ein erneuter Provideraufruf ist für den Spielzug nicht erforderlich. Idempotenz- und Versionsregeln verhindern doppelte Zustandsänderungen.
8. Die KI-Erweiterung verwendet in Tests ausschließlich Mocks und lokale Fixtures. Der vollständige End-to-End-Ablauf wird zusätzlich ohne API-Schlüssel und mit nachweislich null Provideraufrufen geprüft.

## Alternativen

- **LLM als Pflichtbestandteil:** Verworfen, weil API-Schlüssel, Providerverfügbarkeit und Kosten sonst den Kernspielablauf blockieren können.
- **Ausschließlich regelbasierte Freitexterkennung:** Verworfen, weil Schlüsselwort- und Synonymregeln gültige Formulierungen übersehen können und dadurch Spielfortschritt sowie Vergleichbarkeit erschweren.
- **Fragenkatalog und regelbasiertes Freitext ohne KI:** Für den MVP verworfen. Der Katalog garantiert bereits den vollständigen Spielablauf; eine zusätzliche fehleranfällige Erkennungsschicht ist nicht erforderlich.
- **Vollständig offline ohne Backend:** Verworfen, weil dies neue Autoritäts-, Persistenz- und Synchronisierungsmodelle erfordern würde. Private Multiplayer-Räume bleiben bestehen.

## Konsequenzen

Vorteile:

- Der komplette Fall ist ohne externe KI-Dienste, API-Schlüssel und KI-Kosten spielbar.
- Fragen, Hinweise und Bewertung sind reproduzierbar und gezielt testbar.
- Providerfehler blockieren keine bereits gültig angenommene Katalogaktion.
- Frontend und Game Engine können unabhängig vom LLM-Adapter entwickelt werden.

Nachteile und Folgekosten:

- Fallinhalte benötigen kuratierte Fragen und vollständig gepflegte Referenzantworten.
- Ohne KI ist die Befragung auf die Auswahl vorhandener Fragen beschränkt.
- KI-formulierte Antworten können sich textuell von Referenzantworten unterscheiden; Engine-Ergebnisse müssen dennoch identisch bleiben.
- Tests müssen beide Darstellungswege sowie den Fehler-Fallback abdecken.

## Umsetzung

Die Entscheidung wird in `AGENTS.md`, `README.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `specs/game-loop.md`, `specs/ai-suspects.md` und den Vertragsentwürfen verankert.

Betroffene Umsetzungstasks:

- T001: Katalogidentitäten und Befragungsvertrag ohne Providerpflicht
- T007: vollständiger Fall mit Fragenkatalog und Referenzantworten
- T008: optionale KI-Formulierung und statischer Fehler-Fallback
- T009: katalogbasierte Befragung in der Spieloberfläche
- T010: vollständiger E2E-Ablauf ohne Provider und Vergleich der kanonischen Ergebnisse
- T011: Betrieb und Readiness ohne erforderliche KI-Konfiguration
