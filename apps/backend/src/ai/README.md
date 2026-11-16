# Optionaler AI-Providerport (T008)

Dieses Verzeichnis ist ausschließlich serverseitig. Es verändert weder Shared Contracts noch die Game Engine und wird nicht in das Frontend exportiert. Der Fall bleibt mit dem bestehenden T007-Katalog vollständig ohne Provider spielbar.

## Ports und Aktivierung

- `DialogueProvider.generateDialogue(context)` implementiert den internen Vertrag aus `specs/ai-suspects.md`.
- `OpenAiDialogueProvider` kapselt OpenAI hinter `OpenAiHttpTransport`. `FetchOpenAiHttpTransport` ist die einzige netzwerkfähige Implementierung; Tests injizieren immer einen Offline-Mock.
- `createOpenAiProviderFromEnv` ist ein **expliziter Opt-in-Composition-Hook** und wird vom bestehenden Backend-Start, Health, Readiness und dem Referenzpfad nicht aufgerufen. Nur diese Funktion liest die bereits vorhandenen Variablen `OPENAI_API_KEY` und `OPENAI_MODEL`.
- Sind beide Werte leer/unset, liefert die Factory `null`: keine Konfiguration, kein Modellpfad und kein Transportaufruf. Eine bewusst teilweise aktivierte/ungültige Konfiguration liefert `unavailable`, ebenfalls ohne Transport.
- `MockDialogueProvider` besitzt keinerlei Netzwerkimplementierung und dient festen Fixtures und kontrollierten Fehlerfällen.

Es wurden keine neuen Umgebungsvariablen, Deployment-Einstellungen, API-Endpunkte oder Kostenkonfigurationen eingeführt. API-Schlüssel befinden sich nur im serverseitigen Authorization-Header und niemals im Providerkontext, Prompt, Log oder Client-DTO.

## Kontext- und Promptgrenzen

`AuthorizedDialogueContextSchema` validiert den bereits autorisierten, serverseitig kuratierten Kontext erneut an der Adaptergrenze:

- diskriminiert `catalog` mit genau einer Referenzantwort oder `free_text` mit `referenceAnswer = null`;
- `language = 'de'`, `timeoutMs = 5000`, `maxOutputTokens = 600` sind Literale;
- keine Felder für User-/Session-/Request-IDs, E-Mail, Rollen, `questionId`, Auth-/Provider-Secrets, `CaseTruth`, `SuspectSecret`, fremde private Hinweise oder Engine-State.

`prompts.ts` besitzt die feste Version `suspect-dialogue-de.v1`. Systemanweisungen enthalten keine interpolierten Fall- oder Spielertexte. Alle freigegebenen Zeichenketten erscheinen ausschließlich JSON-serialisiert in der einen User-Datennachricht. Insbesondere Katalog-/Freitextfragen können dadurch keine System-/Developer-Rolle übernehmen. Das Modell erhält keine Engine-, Datenbank-, Tool- oder Broadcastfähigkeit.

T009 darf den Kontext nur aus der bereits geprüften Aktion und einer ausdrücklich freigegebenen Charakterprojektion erstellen. Komplette `CaseDefinition`-, `EngineState`- oder `SuspectDefinition`-Objekte dürfen nicht durchgereicht werden. Eine freigegebene Katalogreferenz und kuratierte `allowedFacts` sind zulässig; verborgene Wahrheit und fremde private Informationen sind es nicht.

## Ausgabe und kontrollierte Fehler

Das eigentliche Modell-JSON wird als `unknown` gelesen. `DialogueModelOutputSchema.strict()` akzeptiert ausschließlich:

```json
{ "dialogue": "1–4000 Zeichen nach Trim + Unicode NFC" }
```

Zusatzfelder wie IDs, `mood`, Hinweise, Scoring, Phasen, `suggestedIntent`, Lösung oder State-Patches erzeugen `invalid_output`; sie werden nicht in Engine, Receipt, Event oder Broadcast übernommen. Schädliche C0-/DEL-Control-Zeichen werden abgelehnt. Zeilenumbrüche und Tabs bleiben als normaler Dialogtext möglich.

- Timeout: `timeout`
- Provider-/HTTP-/Transport-/Envelope-/JSON-Parsingfehler: `provider_error`
- Modell-Content-/Schemafehler: `invalid_output`
- fehlende/ungültige Aktivierung: `unavailable`
- Sessionbudget: `budget_exceeded` im kontrollierten Port, die Entscheidung selbst gehört T009

OpenAI-Fehlerlogs enthalten ausschließlich `{ category, requestId }` mit den Kategorien `timeout`, `provider_error` oder `invalid_output`. Keine Prompts, Modell-/Providerrohtexte, Nutzungsantworten mit Inhalten, Stacktraces, Keys oder geheimen Charakterdaten werden geloggt.

## Ein Aufruf, Timeout und Darstellungsfallback

Pro Adapteraufruf startet `OpenAiDialogueProvider` genau einen Transport-Request ohne Retry/Backoff. Der Request verlangt `n = 1`, JSON-Objektausgabe und `max_tokens = 600`. Ein gefakt- oder real getesteter `AbortController` bricht nach exakt 5000 ms ab; `Promise.race`, Fehlerbehandlung für späte Settlements und `finally` bereinigen Timer auch dann, wenn ein Transport den Abort ignoriert.

`presentCatalogueDialogue` ruft einen injizierten Provider höchstens einmal auf:

| Situation                                                  | Sichtbarer Text                         | `answerSource` |
| ---------------------------------------------------------- | --------------------------------------- | -------------- |
| `provider = null`                                          | exakt die bereits freigegebene Referenz | `reference`    |
| validierter Providererfolg                                 | ausschließlich validierter Dialogtext   | `ai`           |
| jeder Providerfehler einschließlich Timeout/invalid/budget | exakt dieselbe Referenz                 | `fallback`     |

Der separat zurückgegebene `canonical`-Wert ist stets dieselbe unveränderte, zuvor deterministisch berechnete Engine-Auswertung. T009 übernimmt den geprüften Darstellungstext und seine Quelle in die Dialogdaten **vor demselben einen CAS** und darf weder Engine erneut ausführen noch Modell-State-Patches interpretieren. KI kann deshalb weder Frage-/Hinweisidentitäten noch Phasen, Fallwahrheit oder Bewertung verändern.

`presentFreeTextDialogue` erzeugt kein `questionId` und keine Engine-Wirkung. Erfolg ist `answerSource = ai`, `visibility = actor`, `engineEffect = none`. Jeder Fehler liefert ausschließlich `AI_UNAVAILABLE`, weiterhin actor-scoped und ohne Referenz-/Katalograten. Persistenz, genau eine Sessionversionserhöhung und ausschließlich actor-berechtigte Projektion/Übertragung bleiben T009.

## In-flight, Replay und Crashgrenze

`DialogueExecutionCoordinator` ist eine prozessinterne Single-Flight-/Replay-Hilfe, **kein Receipt- oder Sessionstore**:

- Scope: `(actorUserId, operation, aggregateId, clientRequestId)`
- Payloadbindung: Modus, Verdächtiger, `expectedVersion` sowie Katalog-`questionId` oder Freitext-`questionText`
- exakt identische aktuelle Ausführungen teilen dieselbe Promise und damit den einen Provideraufruf;
- geänderter Payload im selben Scope erzeugt `IDEMPOTENCY_KEY_REUSED`, ohne die konkurrierende Ausführung zu starten;
- nur `receipt = 'persisted'` wird nach einem bestätigten T009-Erfolg für Replay vorgehalten; Fehler, Exceptions und `receipt = 'absent'` werden zuverlässig aus in-flight entfernt und nicht als Erfolg gecacht;
- erfolgreiche lokale Replays starten keinen erneuten Provideraufruf. Der LRU ist standardmäßig auf 128 erfolgreiche Werte begrenzt; in-flight Einträge werden in jedem Settlementpfad entfernt. Es gibt kein Betriebs-/Debug-HTTP-API.

Die Coordinator-Werte liegen nur im RAM und sind keine Autorität. **T009 prüft zuerst das persistente Erfolgs-Receipt und die aktuelle Autorisierung**, bevor budgetierte Arbeit beginnt, und markiert den Coordinator erst nach erfolgreichem CAS als `persisted`. Bei LRU-Eviction oder Prozessneustart verhindert ausschließlich das persistente Receipt einen erneuten Provideraufruf für einen bereits erfolgreichen Replay.

Nach Crash, CAS-Verlust oder unklarem Ausgang **ohne Erfolgs-Receipt** darf eine spätere neue Use-Case-Ausführung erneut reservieren und genau einmal aufrufen. Jede solche Ausführung zählt erneut. Es gibt bewusst keine crashübergreifende Einmalgarantie pro `clientRequestId` und keinen erzwungenen Retry innerhalb derselben Ausführung.

## Ausdrücklich reservierte T009-Ownership

T008 enthält keine Session-ID im Providerkontext und besitzt kein Budget-/Persistenzmodul. T009 bleibt verantwortlich für:

1. Authz, Phase, `expectedVersion`, Payload-/Sichtbarkeitsprüfung und bestehende Receipts/in-flight vor neuer Arbeit;
2. Katalog-/Freitext-Rate-Limits aus `specs/security-boundaries.md`;
3. atomares `reserveProviderAttempt` mit höchstens 60 Reservierungen über beide Modi, inhaltlose Attempt-Buchungen und keine Erstattung nach Fehler/Crash;
4. keinen Provideraufruf ohne erfolgreiche Reservierung; Budgetablehnung als Katalog-`fallback` bzw. Freitext-`AI_UNAVAILABLE`;
5. genau einen bestätigten Adapterversuch nach Reservierung und inhaltloses `succeeded`/`failed`-Settlement per `attemptId`;
6. genau einen atomaren CAS von finaler Antwort, unchanged canonical State, Receipt, Eventrohdaten und Versions semantik;
7. aktuelle Autorisierung bei Projektion/Replay, actor-only Freitext und Broadcast erst nach Commit.

## Offline-Verifikation

```bash
pnpm --filter @casetogether/backend exec vitest run test/ai --reporter=verbose
```

Die Suite nutzt ausschließlich feste, ausdrücklich fiktive Fixtures, Transport-/Provider-Mocks und gefakte Timer. Sie umfasst strikte Zusatzfeld-/Längen-/Control-Validierung, HTTP-/JSON-/Schemafehler, Timeout/Abort, Tokenlimit, OpenAI-zu-Fallback-Integration, Prompt-Injection und Datenminimierung, vollständige T007-Katalogäquivalenz inklusive finaler Bewertung, Freitextgrenzen sowie in-flight/Replay-/Konflikt-/Cleanup-Fälle. Für AI-Tests werden weder echte Schlüssel noch Live-APIs benötigt oder aus bestehenden Umgebungsvariablen gelesen.
