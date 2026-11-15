# Spec: Verdächtigen-Dialoge und optionale KI

## Ziel

Verdächtige reagieren glaubwürdig, bleiben innerhalb der festgelegten Fallwahrheit und sind vollständig ohne LLM befragbar. Fest geschriebene Referenzdialoge gewährleisten den Spielablauf; KI ist eine optionale dialogische Erweiterung gemäß `docs/adr/0001-ki-dialoge-optional.md`.

Verbindliche Transporte: `contracts/events.md`. Die beiden Modi `catalog` und `free_text` sind getrennte diskriminierte Payloads, keine serverseitig erratene Freitext-zu-Katalog-Erkennung.

## Referenzdialog und Katalogmodus

- Jede Katalogfrage besitzt stabile `questionId`, Verdächtigenbezug und fest gepflegte Referenzantwort in einer fixierten `CaseVersion`.
- Alle für die Falllösung erforderlichen Fragen, Antworten und Hinweisfolgen existieren unabhängig von einem Modell.
- Ohne Providerkonfiguration verwendet der Dialogue-Use-Case ausschließlich Referenzantworten (`answerSource = reference`) und ruft keinen Provider auf.
- Eine optional formulierte Antwort verwendet `answerSource = ai`; nach Providerausfall, Timeout oder ungültiger Ausgabe verwendet eine ansonsten gültige Aktion die Referenzantwort exakt mit `answerSource = fallback`.
- Die Engine-Auswertung einschließlich öffentlicher/privater Hinweise, Folgefragen, Phase und finaler Bewertung wird vor und unabhängig von einer KI-Darstellung bestimmt. `answerSource` ist kein Engine-Input.
- Fragen und Antworten folgen `room`-/`actor`-Sichtbarkeit. Private Daten anderer Spieler und nicht freigegebene Fallinhalte fehlen in jedem Client-DTO und Providerkontext.
- Erfolgreich verarbeitete Wiederholungen derselben `clientRequestId` nutzen das gespeicherte Receipt; eine KI-Formulierung oder Fallbackentscheidung wird dabei nicht erneut ausgeführt.

## Optionale Freitext-KI

- `mode = free_text` enthält `questionText` und niemals `questionId`. Er ist optional und für Hinweise, Folgefragen, finale Bewertung oder Fallabschluss irrelevant.
- Dieser Modus hat keine Engine-Auswertung und erzeugt ausschließlich einen actor-only Dialog. Andere Spieler erhalten weder Freitext noch Antwort; ihre Versionssprünge reparieren sie per Snapshot.
- Fehlt ein Provider, läuft er in Timeout/Fehler oder liefert ungültige Ausgabe, antwortet der Request mit `AI_UNAVAILABLE`. Es wird keine Katalogfrage geraten und keine Referenzantwort als vermeintlich passender Freitext-Fallback erfunden.
- Ein erfolgreicher Freitextdialog verwendet `answerSource = ai`, besitzt `questionId = null` und verändert nur die Dialog-/Sessionprojektion. Die Sessionversion erhöht sich einmal, der deterministische Engine-State bleibt unverändert.
- Freitextlimits umfassen Payloadlänge, Rate, Provider-Timeout und serverseitige Kosten-/Aktionsbudgets. Sie blockieren nicht den Katalogmodus.

## Charakterdefinition

- Identität und Persönlichkeit
- öffentliche Hintergrundinformationen
- bekannte Fakten
- Geheimnisse
- erlaubte Aussagen
- Tabuthemen/Antwortgrenzen
- Sprechstil

## Serverseitiger Providervertrag

Der folgende Vertrag gehört zum Backend/AI-Adapter und wird **nicht** in Client-DTOs exportiert. T008 implementiert ihn als TypeScript-/Zod-Port; T009 injiziert ihn in den Dialogue-Use-Case.

```ts
interface AuthorizedDialogueContext {
  mode: 'catalog' | 'free_text';
  questionText: string;
  publicCharacterContext: string;
  allowedFacts: string[];
  referenceAnswer: string | null; // catalog: kuratierte Referenz; free_text: null
  language: 'de';
  promptVersion: string;
  timeoutMs: 5000;
  maxOutputTokens: 600;
}

type AiProviderFailureReason =
  | 'unavailable'
  | 'timeout'
  | 'provider_error'
  | 'invalid_output'
  | 'budget_exceeded';

type AiProviderResult =
  | { ok: true; dialogue: string }
  | { ok: false; reason: AiProviderFailureReason };

interface DialogueProvider {
  generateDialogue(context: AuthorizedDialogueContext): Promise<AiProviderResult>;
}
```

- `AuthorizedDialogueContext` wird ausschließlich serverseitig aus der bereits gültig geprüften Katalogaktion beziehungsweise dem autorisierten Freitextzweig erzeugt. Er enthält keine User-/Session-IDs, E-Mail, Host-/Rollendaten, fremden private Facts, Lösung, geheimen Trigger oder Auth-/Provider-Secrets.
- `catalog` erhält die eine bereits zugeordnete Referenzantwort ausdrücklich als Darstellungsgrundlage. `free_text` erhält `referenceAnswer = null` und ausschließlich kuratierte `allowedFacts`; daraus wird keine Katalogidentität abgeleitet.
- Die eigentliche Modellausgabe wird als `unknown` gelesen und muss **exakt** `{ "dialogue": string }` entsprechen: Objekt ohne Zusatzfelder, NFC/Trim, 1–4000 Zeichen. `mood`, `suggestedIntent`, `safetyFlags`, IDs, Hinweise, Bewertung, Phasen oder State-Patches sind nicht zulässig und führen zu `invalid_output`, nicht zu einer Engine-Auswertung.
- Die Adapterergebnisse sind ein kontrollierter interner Union, kein ungefilterter Provider-/HTTP-Fehler. Provider-Rohbody, Stacktrace, Nutzungsstatistik mit Inhalten und Exceptions werden nicht nach außen oder in Client-DTOs weitergereicht. Technische Token-/Kostenmetriken dürfen separat inhaltlos erfasst werden.
- Pro **Use-Case-Ausführung** gibt es höchstens einen Provideraufruf, standardmäßig `timeoutMs = 5000`, `maxOutputTokens = 600`; kein automatischer Adapter-Retry/Backoff. Zusammengeführte in-flight Requests und erfolgreiche Receipt-Replays führen keine weitere Ausführung mit neuem Aufruf aus. Ohne aktivierten Provider wird `generateDialogue` gar nicht erst aufgerufen.
- Ein erneuter Use-Case-Versuch nach CAS-Verlust, Prozessabbruch oder unklarem Ausgang **ohne Erfolgs-Receipt** darf nach neuer Reservierung erneut einen Provideraufruf erzeugen. Es gibt dafür keine crashübergreifende Einmalgarantie pro Request-ID. Jeder dieser Versuche verbraucht Raten-/Sessionbudget; erfolgreiche Receipt-Replays garantieren dagegen keinen neuen Aufruf.
- Katalog bildet jedes failure-Ergebnis auf die Referenzantwort mit `answerSource = fallback` ab; Freitext bildet es allgemein auf `AI_UNAVAILABLE` ohne neue Engine-Wirkung ab. Eine Budget-/Providergrenze blockiert niemals den Referenzmodus.

### Sessionbudget und persistente Versuchsreservierung

Die Durchsetzung des gemeinsamen Limits liegt ausdrücklich beim **T009-Backend-Dialogue-Use-Case und seinem Game-Session-Repository**, nicht beim T008-AI-Adapter. Der Adapter und `AuthorizedDialogueContext` benötigen deshalb keine Session-ID. T008 begrenzt Provideraufruf, Timeout, Ausgabetokens und Providerfehler; T009 koordiniert sessionweite Verbräuche und Persistenz.

1. Der Use Case prüft zuerst erfolgreichen Receipt/in-flight Key, Authz, Phase und aktuelle `expectedVersion`. Ein bestehender Erfolg oder identischer in-flight Request löst keine neue Budgetreservierung oder Providerausführung aus.
2. Für eine neue, tatsächlich auszuführende KI-Verwendung erzeugt der Server eine `executionId` und einen serverseitigen `attemptId`. Dazu werden Actor, Operation, Aggregate, `clientRequestId` und Modus gespeichert. Eine spätere Ausführung ohne Erfolgs-Receipt erhält eine neue Execution, niemals eine scheinbar fortlaufende externe Verbindung.
3. `reserveProviderAttempt` ist ein atomares Session-Update mit `sessionId`, `phase = investigating`, `version = expectedVersion` und `aiUsage.providerAttemptsReserved < 60`. Nur dieses Update erhöht den serverseitigen Zähler um eins und hängt eine `reserved`-Buchung an. Es erhöht **nicht** die Game-Version, verändert keine Engine-Daten und erzeugt kein Event.
4. Erst nach erfolgreicher Reservierung ruft der Use Case den Adapter genau einmal auf. Ohne Reservierung findet kein Aufruf statt. Beim Reload wird unterschieden: veraltete Version `VERSION_CONFLICT`; erschöpftes Budget im Katalog normaler Referenzfallback per Spiel-CAS, in Freitext `AI_UNAVAILABLE` ohne Event. Bereits gültig berechnete Katalogreferenz bleibt dadurch abschließbar.
5. Ergebnis/Timeout/invalid_output wird inhaltlos als `succeeded`/`failed` anhand `attemptId` markiert. Die Reservierungszahl wird nicht zurückerstattet. Auch Absturz nach Reservierung oder unklares Netzwerk-Outcome kann eine offene Buchung hinterlassen; sie zählt konservativ weiter. Parallele Ausführungen und Restarts können damit höchstens 60 Reservierungen pro Session erzeugen.
6. Nachfolgende Domain-CAS/Reservationsupdates aktualisieren Felder atomar und ersetzen nie das gesamte Sessiondokument. Eine unbestätigte Ausführung ohne Erfolgs-Receipt darf erneut reservieren/aufrufen und zählt erneut; ein erfolgreicher Replay darf weder reservieren noch aufrufen.

Die Reservationen mit `attemptId`, Execution, Actor, Operation, Aggregate, `clientRequestId`, Modus, `reservedAt`, `settledAt` und Status sind serverseitige Betriebs-/Kostenmetadaten. Sie enthalten keine Prompts oder Dialogtexte und gelangen niemals in Client-DTOs, Engine-Ergebnisse oder Broadcastprojektionen.

## Kontextgrenzen

Der Server stellt pro Anfrage nur den notwendigen, ausdrücklich freigegebenen Kontext zusammen. Fall-Täter, komplette Wahrheit, fremde private Hinweise, nicht freigegebene Referenzantworten und geheime Fakten werden nicht pauschal an Charakter oder Modell übergeben. Spieler-/Freitexteingaben sind Daten in einem abgegrenzten Kontext, keine Systemanweisungen.

Katalogantworten besitzen immer eine kanonische Engine-Auswertung unabhängig vom Modell. Modellantworten sind untrusted, werden vor Persistenz validiert und enthalten nur die erlaubte Dialogdarstellung. State-Patches, neue `questionId`/`clueId`, Bewertungen oder Lösungsangaben aus dem Modell sind nicht Teil des Providervertrags und werden verworfen.

## Fallback und Persistenz

- Erfolg bedeutet persistierte, idempotente Aktion samt Receipt und Eventrohdaten; Providerkandidat allein ist kein Spielzug.
- Streaming-/Retry-Parallellität darf die Version nicht doppelt erhöhen. Der CAS gewinnt genau einmal; ein veralteter Versuch wird nicht auf neuer Version erneut ausgewertet.
- Providerfehler nach bereits gültig berechneter Katalogaktion liefern einen einzigen Referenzfallback vor demselben CAS. Zusammengeführte in-flight Requests und erfolgreiche Replays verhindern einen zweiten Provideraufruf. Nach Abbruch/CAS-Verlust ohne Erfolgs-Receipt darf eine neue Ausführung erneut reservieren und aufrufen; dies zählt erneut auf das Sessionbudget.
- Nutzerfeedback kennzeichnet Referenz, KI und Fallback transparent über `answerSource`, offenbart aber keine Prompt-/Providerdetails.
- Logs enthalten keine vollständigen Prompts, Modellrohtexte, API-Schlüssel oder geheimen Kontexte.

## Akzeptanz

- Der gesamte Fall ist ohne Provider, API-Schlüssel und Provideraufrufe abschließbar; Backend-Start und Readiness benötigen keinen Provider.
- Modell kann keine Hinweise/Folgefragen/Bewertung direkt freischalten und Täter/Spielphase nicht ändern.
- Prompt-Injection in Katalogmetadaten und Spieler-Freitext überschreibt keine Systemregeln oder Sichtbarkeitsgrenzen.
- Antwort erfüllt Server-Schema und Längenlimit; nicht vertrauenswürdige Zusatzfelder gelangen nicht in DTOs.
- Dieselbe Katalogaktion erzeugt mit `reference`, `ai` und `fallback` identische kanonische Hinweise, Folgefragen, Phasen und Bewertungen.
- Der Katalog-Fallback liefert die Referenzantwort ohne doppelte Zustandsänderung oder erzwungenen Provider-Retry.
- Die optionale Freitextvariante wird ohne Provider/mit ungültiger Antwort mit `AI_UNAVAILABLE` beendet, erzeugt keine Engine-Wirkung und bleibt actor-only.
- Tests und CI benutzen Mocks/lokale Fixtures; der Basispfad beweist null Provideraufrufe.
