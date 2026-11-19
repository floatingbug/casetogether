# Datenmodell, Indizes und Datenklassifikation

Dieses Dokument konkretisiert die Persistenz für den T001-Vertrags-Freeze. Öffentliche Transportobjekte stehen ausschließlich in `contracts/`; Persistenzdokumente dürfen niemals unselektiert serialisiert werden. Alle Collections enthalten `schemaVersion` für kontrollierte Migrationen.

## 1. Collections

### `users`

- `_id`, `schemaVersion`
- `emailNormalized`: eindeutige, lowercase normalisierte E-Mail; player-private und kein Raum-DTO
- `passwordHash`: Argon2id mit eigenem Salt und Parametersatz; server-secret
- `displayName`
- `createdAt`, `updatedAt`

Ein externer Identity-Provider ist im MVP-Vertrag nicht vorgesehen. Authentifizierung erfolgt laut ADR-002 mit lokalen Zugangsdaten und persistierten Auth-Sessions.

### `authSessions`

- `_id`, `schemaVersion`
- `sessionIdHash`: Hash der zufälligen Session-ID, nicht des vollständigen Set-Cookie-Headers; server-secret
- `userId`
- `createdAt`, `expiresAt`, `revokedAt: Date | null`
- optionale technische Rotations-/Invalidierungsmetadaten ohne Tokens im Klartext

Lookup und Revocation verwenden `sessionIdHash`; Ablauf und `revokedAt` werden im Use Case geprüft und nicht nur vom TTL-Löschzeitpunkt abhängig gemacht.

### `cases`

- `_id`, `schemaVersion`, `slug`, `version` (SemVer-String), `status: draft | published | retired`
- sichere Zusammenfassung (`title`, `description`, `estimatedDurationMinutes`)
- `publicSuspects`: lediglich ID, Anzeigename und öffentliche Beschreibung
- `suspectDefinitions`: Charakterwissen, Geheimnisse, erlaubte Kontexte, Sprechstil; server-secret bis auf ausdrücklich kuratierte Projektionen
- `questions`: stabile `questionId`, `suspectId`, Fragetext, Referenzantwort, Sichtbarkeit `room | actor`, Freischaltbedingungen und Engine-Auswertung
- `clues`: öffentlicher/privater Anzeigeinhalt sowie serverseitige Regel- und Sichtbarkeitsbedingungen
- `solution`: Täter, deterministische Bewertung und Auflösung; server-secret bis `completed`
- `createdAt`, `updatedAt`

Der Server wählt beim Start genau eine publizierte Version und fixiert deren immutable Inhalte für die Session. Eine publizierte Fallversion wird nicht inhaltlich überschrieben; Änderungen erzeugen eine neue `version`. Clients erhalten aus dieser Collection nie vollständige Dokumente.

### `rooms`

- `_id`, `schemaVersion`
- `status: waiting | ready | in_progress | closed`, `version` (startet bei 1)
- `hostUserId`, `members[]`: jeweils `userId`, `role`, `joinedAt`; maximal vier, serverseitig auf eindeutige `userId` begrenzt
- `maxPlayers: 4`
- `invitation`: `codeHash`, `createdAt`, `expiresAt`; **kein Klartextcode**
- `activeSessionId: ObjectId | null`
- `actionReceipts[]`: erfolgreiche Raum-Commands/No-op-Joins mit `actorUserId`, `operation`, `aggregateId`, `clientRequestId`, `payloadHash`, eindeutigem `lookupKey` sowie nichttextuellen Ergebnisverweisen (`roomId`, Event-/Message-ID, Version); server-only. **Kein Klartextcode und keine vollständige Secret-Response.** Create/Rotate verweisen für Replays ausschließlich auf die codefreie `SecretReplayResponse`.
- `createdAt`, `updatedAt`, `expiresAt`
- `deleteAfter: Date | null`: ausschließlich Cleanup-Termin für ungestartete/abgelaufene Lobbys; beim erfolgreichen Start entfernen

Codes werden nach Entfernen der Gruppenbindestriche in Großbuchstaben kanonisiert und mit SHA-256 gehasht. Aufgrund ihrer 60 Bit Zufallsentropie ist kein niedrig-entropischer Passwort-KDF erforderlich. Klartextcode existiert nur zur Erzeugung/Rotation in Memory und der **ersten erfolgreichen** Create-/Rotate-Host-Response (`outcome = created | rotated`); nie in Receipts, Replay-Responses, Logs, Snapshots oder Broadcasts. Persistente Create-/Rotate-Replays erzeugen bewusst nur `outcome = replayed`, `roomId`, `invitation = null` und `recovery = rotate_with_new_client_request_id_if_needed`.

### `gameSessions`

- `_id`, `schemaVersion`, `roomId` (eine Session pro MVP-Raum, unique)
- `startIntent`: serverseitige Start-/Recovery-Daten `actorUserId`, `operation = room:start`, `roomId`, `clientRequestId`, `payloadHash`, `expectedRoomVersion`, `caseId`, `caseVersion`, `status: pending | prepared | superseded`, `createdAt`, `preparedAt`, `supersededAt`; **kein öffentlicher GamePhase**
- `caseId`, `caseVersion` mit immutable/fixiertem Fallinhalt oder eindeutig versionierter Referenz
- `phase: investigating | completed | abandoned`, `version` (startet bei 1)
- `members[]` als Start-Mitgliedschaft; Autorisierung wird zusätzlich gegen den aktuellen Raum geprüft
- `engineState`: deterministischer Zustand inklusive Freischaltungen und geheimer Fakten; server-secret
- `memberStates[]`: nur jeweils berechtigte private Frage-/Hinweiszustände
- `publicClues[]`, `finalSubmission`, `result` und `resolution` mit den Regeln aus Shared Contracts
- `dialogues[]`: Referenz-/KI-Darstellung plus serverseitiger Sichtbarkeit `room | actor` und berechtigtem Actor; Rohdaten server-only
- `events[]`: rohe persistierte Eventdaten mit `eventId`, `version`, `type`, `occurredAt`, Actor und getrennten öffentlichen/privaten Inhalten; server-only
- `actionReceipts[]`: Idempotenz-Key-Bestandteile, Payload-Hash, persistierte Ergebnis-/Event-Referenz; server-only
- `aiUsage.providerAttemptsReserved`: Integer 0–60 für beide KI-Modi zusammen; `aiUsage.attempts[]` mit `attemptId`, `executionId`, Actor, Operation, Aggregate, `clientRequestId`, Modus, `status: reserved | succeeded | failed`, `reservedAt`, `settledAt`; server-only, maximal 60 Buchungen, keine Prompts/Dialogtexte
- `startedAt`, `finishedAt`, `updatedAt`
- `deleteAfter: Date | null`: erst nach `completed`/`abandoned`, standardmäßig 30 Tage nach `finishedAt`

Der atomare Mutationsschreibzugriff gemäß ADR-003 kapselt Engine-State, Dialog, Eventrohdaten, Receipt und Version in einem Dokument. `reserveProviderAttempt` erhöht vor einem etwaigen Provideraufruf unter `sessionId + phase + erwarteter Version + providerAttemptsReserved < 60` nur `aiUsage.providerAttemptsReserved` und hängt eine `reserved`-Buchung an; weder Game Version noch Engine/Event-State ändern sich. Erfolgs-Receipts/in-flight vermeiden erneute Reservierungen, spätere Ausführungen ohne Receipt zählen erneut. Jede Feldmutation erfolgt atomar ohne Gesamtdokument-Replacement. Offene Reservierungen werden nach Crash nicht erstattet; Budgeterschöpfung verhindert den Aufruf und nutzt Katalog-Referenzfallback beziehungsweise `AI_UNAVAILABLE`. `events[]` ist kein öffentlicher Event-Sourcing-Stream und wird nicht direkt an Clients gesendet. `startIntent` wird bereits beim ersten Insert persistiert und identifiziert Crash-Recoveries erst nach vollständiger Übereinstimmung; `pending`/`prepared` ist nur intern sichtbar. Ein öffentlicher Session-Read verlangt `prepared`, passenden `rooms.activeSessionId`-Link und aktuelle Mitgliedschaft. `superseded` markiert nachweislich nicht verknüpfte abgebrochene Intents und niemals verlinkte/begonnene Spielstände. Die eingebettete Historie wird durch begrenzte Eingaben, Raten und Fallgröße kontrolliert; ihr Wachstum ist zu messen. Eine Auslagerung oder Dokument-Splittung erfordert ADR und Migrations-/Transaktionskonzept.

### `messages`

- `_id`, `schemaVersion`, `roomId`
- `senderUserId`, `clientRequestId`
- `content`, `createdAt`
- `deleteAfter: Date | null` entsprechend dem zugehörigen Raumabschluss/Aufbewahrungskonzept

Chat ist raum-privat, aber kein engine-autoritativer State. Er hat weder Raum- noch Sessionversion. Der Client erhält maximal die letzten 50 berechtigten Nachrichten im Room-Snapshot; Live- und Snapshot-Duplikate werden mit `id` dedupliziert.

## 2. Zugriffsmuster und Indizes

| Collection | Index | Zweck |
|---|---|---|
| `users` | unique `emailNormalized` | genau ein Konto pro normalisierter E-Mail |
| `authSessions` | unique `sessionIdHash` | Auth-Lookup |
| `authSessions` | `userId`, `revokedAt` | nutzerspezifische Revocation/Logout |
| `authSessions` | TTL `expiresAt` | Cleanup abgelaufener Sessions; fachlicher Ablauf wird trotzdem geprüft |
| `cases` | unique `(slug, version)` | immutable publizierte Version |
| `cases` | `(status, version)` | veröffentlichte Fälle |
| `rooms` | unique `invitation.codeHash` | Einladungs-Lookup ohne Klartext; Kollision beim Erzeugen erneut würfeln |
| `rooms` | `_id`, `members.userId` | autorisierte Snapshots/Membership-Query, nicht ohne Bedingung an Clients ausgeben |
| `rooms` | `(actionReceipts.actorUserId, actionReceipts.operation, actionReceipts.clientRequestId)` | Join-/Create-Replay auch nach Codewechsel; Payload-Hash erneut vergleichen |
| `rooms` | unique `actionReceipts.lookupKey` | voller Idempotenz-Scope, zusätzlich durch atomare Prädikate abgesichert |
| `rooms` | TTL `deleteAfter` | tatsächlich vorgesehener Lobby-Cleanup; `null` ignoriert |
| `gameSessions` | unique `roomId` | atomarer Schutz gegen zwei Starts desselben MVP-Raums |
| `gameSessions` | `_id`, `version` | CAS für State + Receipt + Event + Version |
| `gameSessions` | `(startIntent.status, startIntent.createdAt)` | Recovery-/Cleanup-Suche, stets Room-Link erneut prüfen |
| `gameSessions` | TTL `deleteAfter` | Cleanup abgeschlossener/verwaister Sessions nach gesetztem Termin |
| `messages` | unique `(roomId, senderUserId, clientRequestId)` | Chat-Idempotenz |
| `messages` | `(roomId, createdAt, _id)` | Snapshot- und Chronologiezugriff |
| `messages` | TTL `deleteAfter` | Chat-Cleanup nur nach gesetztem Termin |

MongoDB erlaubt nicht in jeder Array-/Indexkombination eine Unique-Constraint direkt im Dokument. Receipt- und Mitglieder-Eindeutigkeit wird deshalb zusätzlich durch atomare Prädikate im jeweiligen CAS sowie Integrations-/Concurrency-Tests erzwungen, nicht nur durch Anwendungs-Vorabreads. Neue Indizes müssen mit dem tatsächlich gewählten MongoDB-Schema und Abfrageplan geprüft werden.

TTL-Löschung ist asynchron und nicht sekundengenau. Jeder fachliche Ablauf (`authSessions.expiresAt`, `invitation.expiresAt`, inaktive Lobby) wird beim autorisierten Zugriff unabhängig vom TTL-Lauf abgelehnt. Ein TTL-Index ersetzt weder Berechtigung noch Löschbestätigung in Backups.

## 3. Datenklassifikation und Projektion

| Klasse | Persistente Beispiele | Transportregel |
|---|---|---|
| Raum-öffentlich | Anzeigename, sichere Raummetadaten, sichere Fallzusammenfassung, `publicSuspects`, `room`-Fragen/Dialoge/Hinweise | ausschließlich an authentifizierte aktuelle Raummitglieder |
| Player-private | `emailNormalized`, eigene `actor`-Fragen/Dialoge/Hinweise, eigener Auth-Status | nur betroffener Nutzer; niemals andere Raummitglieder |
| Host-/Einladung privat | neu erzeugter Einladungscode | nur erste erfolgreiche `created`-/`rotated`-Response an Host; persistenter Replay ausschließlich codefrei und mit `outcome = replayed`; nicht aus Hash rekonstruierbar |
| Server-secret | `passwordHash`, Session-Hashes, Wahrheit/Lösung vor Abschluss, Geheimnisse, nicht freigegebene Referenzantworten/Trigger, `engineState`, `startIntent`, Events/Receipts-Rohdaten, `aiUsage`, Providerkonfiguration | niemals in Client-DTO, Client-Log oder gemeinsamen Broadcast |
| Flüchtig | Socket-Verbindungen, Präsenz | bereinigtes vollständiges Präsenzarray nur an Raummitglieder; keine Persistenzautorität |

Die Trennung wird durch eigene Repository-Projektionen und strikte DTO-Outputschemas erzwungen. Insbesondere `events[]`, `dialogues[]`, `memberStates[]`, `actionReceipts[]`, `cases.questions` und `cases.solution` werden niemals per Client-Filterung aus einem bereits vollständig gesendeten Objekt „geschützt“.

## 4. Konsistenz und Startgrenze

Versionierte Raum-/Sessionaktionen verwenden ID + `expectedVersion` sowie Receipt-Payload-Hash in einem atomaren Update. Create/Join/Chat sind ausdrücklich keine `expectedVersion`-Commands. Join sichert Code, Status, Ablauf, Nichtmitgliedschaft, `$size(members) < 4` und eindeutigen Receipt-Lookup in einem einzigen Room-Update; No-op-Joins bestehender Mitglieder erhöhen keine Version. Der Reload nach Nichtmatch klassifiziert `INVITATION_INVALID`, `ROOM_FULL`, `ROOM_NOT_JOINABLE`, `ROOM_CLOSED` beziehungsweise bestehenden Erfolg gemäß ADR-003. Provider-/Netzwerkaufrufe halten keine Datenbanktransaktion offen. Erfolg wird erst nach Commit per Ack/Event gemeldet.

Der Spielstart ist die bewusste Zwei-Dokument-Folge im MVP: eindeutige Session mit `startIntent = pending` anlegen, exakt denselben Intent auf `prepared` setzen, dann Room-CAS bei `expectedRoomVersion` mit `activeSessionId`, `in_progress`, Version und Start-Receipt. Erst danach erfolgen `room:started`, `game.started` und Ack. Kein unverknüpfter Pending-/Prepared-Datensatz ist öffentlich lesbar. Ein exakt identischer Retry vollendet jeden Schritt; Abweichungen übernehmen niemals fremde Intents. Definitive CAS-Verluste werden superseded, fremde unverknüpfte Pending-/Prepared-Starts liefern `OPERATION_IN_PROGRESS`. T011 bereinigt nachweislich unverknüpfte Intents kontrolliert nach 15 Minuten: Der Cleanup läuft im Backend-Prozess (Intervall 60 s, Batch maximal 100, sortiert nach `startIntent.createdAt`), liest den Room vor dem Schreiben direkt aus MongoDB, superseded per CAS auf beobachteten Status und `createdAt` und prüft den Room-Link danach erneut. Bei einem zwischenzeitlichen Link stellt er den vorherigen Intent-Zustand markergebunden wieder her; kann er das nicht sicher, entwaffnet er die TTL-Löschung. Es gibt keinen Hard-Delete im Job. Details und Abläufe stehen verbindlich in ADR-003.

## 5. Technisches Aufbewahrungskonzept

Dies sind reversible technische MVP-Defaults, keine abschließende Rechts-/Datenschutzerklärung:

- Auth-Session: sieben Tage absolute Lebensdauer, danach logisch ungültig und TTL-Cleanup; revoke wirkt sofort fachlich.
- Einladungscode: 60 Minuten gültig, bei Rotation sofort ersetzt; Ablauf wird generisch als `INVITATION_INVALID` behandelt.
- Ungestartete Lobby: 24 Stunden nach Erstellung nicht mehr join-/startbar; anschließend darf `deleteAfter` für Cleanup gesetzt werden.
- Abgeschlossene/abandoned Game Sessions: `deleteAfter = finishedAt + 30 Tage`; Chat erhält denselben zugeordneten Cleanup-Termin. Receipt-Replays gelten nur innerhalb dieser Dokument-/Aggregataufbewahrung.
- Nachweislich nicht verknüpfte Start-Intents: nach 15 Minuten `createdAt` als verwaist behandelbar; Cleanup nur nach erneuter Prüfung, dass kein Room darauf verweist und kein aktiver Start entstanden ist. Der Job setzt ausschließlich `startIntent.status = superseded`, `supersededAt`, `updatedAt` und `deleteAfter = now + 15 Minuten`; die bestehende TTL entfernt das Dokument danach. Verlinkte Sessions werden vor und nach dem Schreiben geprüft; bei einem Race wird der vorherige Zustand wiederhergestellt, andernfalls die TTL-Löschung entwaffnet. Veraltete unverknüpfte Starts werden zunächst `superseded`; ein neuer Start darf nur unter vollständig neuer Autorisierung neu initialisiert werden.
- Cleanup-Telemetrie: strukturierte Logs `start_intent_cleanup_run` mit den Zählern `scanned`, `superseded`, `restored`, `skippedLinked`, `skippedChanged`, `failed` sowie `start_intent_cleanup_error` mit `phase` und `category`. Es werden keine Actor-, Request-, Room- oder Session-IDs und keine Dialoginhalte geloggt. Wiederholte `failed`-Werte oder `restore_conflict_disarmed` erfordern eine manuelle Prüfung; ein entwaffnetes Dokument bleibt bis zur Klärung lesbar.
- Präsenz wird nicht persistent gespeichert. Provider-Rohprompts/-responses werden nicht als Betriebslog persistiert; nur erlaubte Spielergebnisse werden gemäß Sichtbarkeit gespeichert.
- Nutzerkonten werden im MVP nicht pauschal per TTL gelöscht. Ein rechtskonformer Selbstbedienungs-/Support-Löschprozess samt E-Mail-, Backup- und Restdatenbehandlung ist vor externem Launch zu klären und implementieren; er ist kein stiller Bestandteil dieses Vertrags.

Backups, Log-Aufbewahrung, gesetzliche Pflichten, Löschfristen und eine mögliche KI-Auftragsverarbeitung werden vor Staging mit externen Testern beziehungsweise Launch geprüft. Die technischen Defaults geben kein Rechtsgutachten und kein Veröffentlichungsdatum vor.
