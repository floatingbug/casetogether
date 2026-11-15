# Spec: Core Game Loop

## Ziel

Eine Gruppe von 2–4 Spielern kann einen Fall gemeinsam abschließen – vollständig ohne LLM, API-Schlüssel oder KI-Kosten. Backend und MongoDB bleiben für Identität, Autorität, Persistenz und Multiplayer-Synchronisierung erforderlich; ein serverloser Offline-Modus ist nicht Ziel des MVP.

Die verbindlichen Transportformen stehen in `contracts/openapi.yaml`, `contracts/shared-types.md` und `contracts/events.md`.

## Raumzustände

- `waiting`: Host hat einen Raum erstellt; ein zweites Mitglied fehlt noch.
- `ready`: Zwei bis vier Mitglieder und ein veröffentlichter Fall können gestartet werden.
- `in_progress`: Genau eine Game Session wurde erfolgreich mit dem Raum verknüpft.
- `closed`: Host hat die Lobby geschlossen oder die ungestartete Lobby ist abgelaufen; kein Join/Start mehr.

`waiting` und `ready` sind keine Game-Session-Phasen. Eine gestartete Session beginnt unmittelbar als `investigating`.

## Sessionphasen und Übergänge

- `investigating`: Befragung, Hinweise und finale Abgabe sind für autorisierte Mitglieder möglich.
- `completed`: Finale Abgabe wurde atomar gespeichert und bewertet; Auflösung ist sichtbar; keine weitere Spielmutation.
- `abandoned`: Serverseitig verwalteter Ablauf/Abbruch ohne Auflösung; keine weitere Spielmutation. Ein generischer Client-Abbruchcommand ist nicht Teil des MVP-Vertrags.

Erlaubte Spielübergänge sind ausschließlich `investigating → completed` durch die finale Abgabe und `investigating → abandoned` durch ein später spezifiziertes serverseitiges Ablaufverfahren. `submitted` ist keine zusätzliche Clientphase: Finale Sperre, Bewertung und Abschluss sind ein atomarer Schritt. Kein KI-Aufruf oder zusätzlicher Reveal-/Voting-Schritt liegt dazwischen.

## Befragung ohne KI

- Jeder Fall enthält einen kuratierten Fragenkatalog pro Verdächtigem mit stabilen `questionId`-Werten und fest geschriebenen Referenzantworten in der fixierten `CaseVersion`.
- Spieler wählen aktuell sichtbare Katalogfragen mit `mode = catalog`. Sie müssen keine freitextlichen Schlüsselwörter oder erwarteten Formulierungen erraten.
- Der Katalog enthält alle für Hinweise und Fallabschluss erforderlichen Aktionen. `mode = free_text` ist eine optionale, actor-only KI-Erweiterung ohne Engine-Wirkung und niemals Voraussetzung.
- Die Engine prüft und verarbeitet eine Katalogfrage deterministisch. Referenzantwort, Hinweise, Folgefragen und zulässige Zustandsänderungen liegen im versionierten Fall beziehungsweise seinen Engine-Regeln.
- `room`-Sichtbarkeit erlaubt eine Weitergabe an alle aktuellen Raummitglieder; `actor`-Sichtbarkeit nur an den auslösenden Spieler. Nicht freigeschaltete Fragen und fremde private Inhalte werden serverseitig weggelassen.
- Optional kann ein LLM die Darstellung einer freigegebenen Referenzantwort ändern. Es erhält keine Zustandsautorität und ist für den Spielfortschritt nicht erforderlich. `answerSource` ist `reference`, `ai` oder `fallback` und kein Engine-Input.
- Dieselbe Katalogaktion erzeugt mit und ohne KI identische kanonische Hinweise, Folgefragen, Phasen und Bewertungen.
- Fehlt ein Provider oder schlägt er vor dem atomaren Commit fehl, verwendet der Server für eine ansonsten gültige Katalogaktion die vorhandene Referenzantwort. Ein Provider-Retry ist für den Spielzug nicht erforderlich.
- Ohne freigegebene Katalogaktion wird aus Freitext keine Engine-Aktion oder Referenzantwort erfunden. Scheitert nur der optionale Freitextzweig, antwortet er mit `AI_UNAVAILABLE`, während der Katalogpfad verfügbar bleibt.

## Regeln

- Nur Host darf den Fall starten; Start nur mit mindestens 2 und höchstens 4 aktuellen Raummitgliedern in `ready`.
- Der Client wählt nur `caseId`; der Server wählt die publizierte Version und fixiert `caseVersion`. Zwei parallele Starts desselben Raums erzeugen höchstens eine verknüpfte Session. Der erste Insert enthält bereits den exakt gebundenen internen `startIntent`; fremde Pending-/Prepared-Starts liefern `OPERATION_IN_PROGRESS`, identische Requests setzen fort, definitive CAS-Verluste liefern `VERSION_CONFLICT`/Superseding. Kein Pending-/Prepared-State ist öffentlich spielbar.
- Täter, nicht freigegebene Wahrheit/Referenzantworten und geheime Trigger sind serverseitig geheim. Erst `completed` darf die freigegebene `CaseResolution` an Raummitglieder senden.
- Hinweise und Folgefragen werden nur durch definierte Engine-Regeln freigeschaltet; KI-Freitext und Modell-Behauptungen erzeugen keine kanonischen Effekte.
- Jedes Mitglied darf die gemeinsame finale Abgabe nach Gruppenabsprache einmal auslösen; ein Voting-System ist nicht Teil des MVP.
- Finale Abgabe enthält nur `suspectId`, Idempotenz und erwartete Version. Der Server berechnet `GameResult`, fixiert `finalSubmission`, `resolution` und `finishedAt`, erhöht die Version genau einmal und setzt `completed`. `game.completed` trägt den vollständig validen empfängerspezifischen Game-Snapshot statt eines unvollständigen Deltas; `game.abandoned` ebenfalls ohne Auflösung.
- Start, Befragung und Finale verwenden `expectedVersion` und `clientRequestId`; veraltete und doppelte Aktionen verändern den State nicht doppelt.
- Ein fehlender LLM-Provider verhindert weder Backend-Start noch Readiness oder einen Spielzug.

## Akzeptanz

- Ungültige Raum-/Sessionübergänge werden mit `INVALID_STATE_TRANSITION` abgelehnt, fremde Ressourcen mit der freigegebenen Fehlersemantik.
- Zwei parallele Startaktionen erzeugen höchstens eine verknüpfte Session und keinen Broadcast vor vollständiger Room-Verknüpfung. Crash-Tests nach Pending-Insert und Prepared-Schreiben beweisen, dass nur derselbe Payload/gleiche Key den `startIntent` fortsetzt und abweichende Requests ihn nicht übernehmen.
- Zwei konkurrierende finale Abgaben beziehungsweise Finale/Katalogaktion mit derselben Ausgangsversion lassen genau einen CAS gewinnen; der andere Request erhält `VERSION_CONFLICT` oder ein gültiges identisches Replay-Ergebnis.
- Ein abgeschlossener/abandoned Fall kann nicht erneut verändert werden; nur noch autorisierte Snapshots sind erlaubt.
- Der vollständige Ablauf von Raumbeitritt bis Auflösung ist ohne konfigurierten Provider möglich und verursacht null Provideraufrufe.
- Alle für den Abschluss notwendigen Hinweise und Lösungsbestandteile sind ausschließlich über Katalogfragen erreichbar; kein Freitext ist erforderlich.
- Providerausfall, Timeout oder ungültige Modellausgabe bei einer ansonsten gültigen Katalogfrage führen zur Referenzantwort ohne doppelte Hinweise, Nachrichten, Bewertung oder Versionserhöhungen.
- Private Fragen/Dialoge/Hinweise erscheinen nur in der Projection des berechtigten Spielers; andere Clients können deren Versionssprünge per Snapshot reparieren, ohne deren Inhalt zu erhalten.
- Jede lückenlos angewandte Eventfolge ergibt wieder einen vollständig schema-validen Game-Snapshot. Terminale Events ersetzen ihn einschließlich `finishedAt`; Katalogevents bleiben bei `phase = investigating`. Schemafehler erzwingen Snapshot-Synchronisation.
