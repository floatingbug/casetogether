# Spec: Rooms & Realtime

Verbindliche Payloads: `contracts/events.md`; REST/Schemas: `contracts/openapi.yaml` und `contracts/shared-types.md`; Versionen/CAS/Join/Start-Recovery: `docs/adr/0003-idempotenz-versionierung-konsistenz.md`.

## Anforderungen

- Private Räume mit 60 Bit zufälligem, gruppiertem Einladungscode. Speicherung nur als Hash; Klartext ausschließlich in der **ersten erfolgreichen** Create-/Rotate-Host-Response. Verlorene Responses erzeugen beim Replay einen diskriminierten codefreien `SecretReplayResponse`, niemals Code in Receipt/Log.
- Maximal vier Mitglieder; Start genau mit zwei bis vier. Hostrolle und Mitgliedschaft sind serverseitig.
- Raumbeitritt ausschließlich per `POST /rooms/join` mit gültigem Code und freiem Platz in `waiting`/`ready`. `room:join` am Socket dient nur bereits autorisierten Mitgliedern zur Live-Synchronisation.
- Logisches Lobby-Verlassen nur über `room:leave`; Verbindungsabbruch ist kein Verlassen. Der Host schließt beim Verlassen die Lobby für alle.
- Realtime-Präsenz und persistierter Gruppenchat; Chat und Präsenz überschreiben niemals fachliche Mitgliedschaft oder Game-State.
- Reconnect, Versionslücken und lokale Schemafehler erhalten aktuelle empfängerspezifische Room-/Game-Snapshots.
- Socket-Handshake prüft Cookie und Origin; jedes Event prüft Authz erneut. Ein Socket.IO-Raumname oder eine `sessionId` ist keine Berechtigung.
- Alle Client-Requests besitzen Pflicht-Acks; mutierende Raum-/Spielaktionen besitzen `clientRequestId`. Persistenz erfolgt vor Broadcast.

## Create, Rotate und verlorene Secret-Response

1. Erfolgreiche Initialerzeugung liefert `201` mit `outcome = created`, Room-Snapshot und `Invitation`. Erfolgreiche neue Rotation liefert `200` mit `outcome = rotated`, RoomSummary und Invitation. Nur diese Responses enthalten Code.
2. Der Receipt speichert Actor, Operation, Aggregate, Request-ID, Payload-Hash, `lookupKey` und `roomId`, nie Klartextcode oder vollständige Secret-Response.
3. Ein identischer authentifizierter Replay vergleicht Key und Payload-Hash und liefert ohne weitere Mutation/Rotation `outcome = replayed`, `roomId`, `invitation = null`, `recovery = rotate_with_new_client_request_id_if_needed`. Create antwortet dann `200`; es gibt keine fette Room-Projection in dieser Variante.
4. Benötigt der Host weiterhin einen Code, verwendet er bewusst die Rotation mit **neuer** Request-ID. Der alte Hash wird dabei einmal atomar ersetzt; nur der erste Erfolg dieser neuen Aktion gibt den neuen Code zurück.
5. Nach Rotation erhalten aktuelle Mitglieder das versionierte Event `room:invitation-rotated` mit Ablaufzeit, jedoch niemals Code, Hash oder Receipt. Die Hostkopie wird über gleiche Version dedupliziert; vermeidbare Leave-Versionskonflikte entstehen nicht.

## Atomarer REST-Join und Replay nach Rotation

Ein Join besitzt bewusst kein `expectedVersion`. Die Reihenfolge lautet:

1. Authentifizierung und strikte Schema-/Payloadvalidierung; normalisierte Codeform und vollständigen Idempotenz-Scope bilden.
2. Exakten Join-Receipt über den Index `(actionReceipts.actorUserId, actionReceipts.operation, actionReceipts.clientRequestId)` suchen und Payload-Hash vergleichen. Dieser Lookup hängt **nicht** vom aktuellen Code-Hash ab. Nur wenn der Actor weiterhin Mitglied ist, liefert er denselben logischen Join-Erfolg als aktuellen autorisierten Room-Snapshot ohne neue Mutation/Version. Ehemalige Mitglieder erhalten `NOT_FOUND`, keinen historischen Snapshot. Abweichender Payload im selben Scope ergibt `IDEMPOTENCY_KEY_REUSED`.
3. Ohne exakten Receipt den aktuell eingereichten Code-Hash auflösen. Ungültige Codes enden mit `INVITATION_INVALID`. Löst er einen Raum auf und ist der Actor bereits Mitglied, handelt es sich um einen idempotenten No-op-Join: autorisierter Snapshot und atomar gegen die weiter bestehende Mitgliedschaft gespeicherter No-op-Receipt, jedoch keine Versionserhöhung. Diese No-op-Receipts ermöglichen ebenfalls Replay nach späterer Rotation; verliert der Server die Mitgliedschaft vor diesem atomaren No-op-Schritt, endet er mit `NOT_FOUND` statt alter Raumdaten.
4. Für ein neues Mitglied erzwingt **ein atomares Room-Update** gleichzeitig:
   - passender `invitation.codeHash`,
   - `invitation.expiresAt > now` und `rooms.expiresAt > now`,
   - `status in waiting|ready`,
   - `members.userId != actorUserId`,
   - `$size(members) < 4` im selben atomaren Prädikat,
   - eindeutiger `lookupKey` für den neuen Receipt.
5. Nur dieses erfolgreiche Update fügt Mitglied und Receipt hinzu, setzt `waiting|ready` aus der neuen Mitgliederzahl und erhöht die Room-Version genau einmal. Vorabreads allein sind keine Vier-Personen-Grenze.
6. Bei Nichtmatch lädt der Server erneut und klassifiziert in dieser Reihenfolge: bestehende Mitgliedschaft/No-op, geänderter/abgelaufener Code (`INVITATION_INVALID`), ungeeigneter Raumstatus (`ROOM_NOT_JOINABLE` beziehungsweise `ROOM_CLOSED`), volle Kapazität (`ROOM_FULL`) oder die noch nicht entscheidbare Paralleloperation (`OPERATION_IN_PROGRESS`). Der identische Retry nutzt weiterhin denselben Key; ein anderes Payload verwendet einen neuen Key.

## Socket-Lifecycle und Handshake

1. Client authentifiziert per HttpOnly-Cookie und zugelassenem Origin.
2. Origin-/Authfehler werden für WebSocket und Long-Polling als `connect_error.data = { error: ApiError }` sowie HTTP-`ErrorResponse` abgebildet. Ungültige Session: HTTP 401/`UNAUTHENTICATED`; Origin/Fetch Metadata: HTTP 403/`CSRF_REJECTED`; interner Fehler: HTTP 500/`INTERNAL_ERROR`. `connect_error.message` ist nie der fachliche Auswertungskanal.
3. Client sendet `room:join { roomId }` und erhält im Ack `{ room, game, serverTime }` in eigener Sicht. Ohne Mitgliedschaft kein Socket-Raumbeitritt.
4. Präsenzsendungen enthalten den vollständigen flüchtigen Online-/Offline-Stand aller Raummitglieder. Sie sind nicht versioniert und werden nicht als Spielhistorie gespeichert.
5. Fachliche Raumänderungen senden Versionsevents; Chat sendet persistierte `ChatMessage`; Spiel sendet versionierte, empfängerspezifische `GameEvent`-Projektionen.
6. Nach `disconnect` setzt der Server Präsenz offline und trennt nur den Socket. Nach Reconnect erfolgt wieder Schritt 3; keine clientseitige Queue ohne Idempotenz gilt als autoritativ.

## Event-Hüllen und Synchronisation

Jedes bestätigte Spielereignis nutzt `eventId`, `sessionId`, `version`, diskriminierten `type`, typisierte empfängerspezifische `payload` und `occurredAt`. Raumereignisse verwenden entsprechend `roomId` und Room-Version. Zusätzlich zu Mitglied-/Start-/Close-Events existiert das codesfreie `room:invitation-rotated`.

Chat verwendet `message.id` sowie `(createdAt, id)` statt künstlicher Raum-/Sessionversionen. Präsenz verwendet einen vollständigen unversionierten Zustand.

Clients wenden nur `localVersion + 1` direkt an und deduplizieren ältere/bekannte Event-IDs. Größere Sprünge können neben Verlust auch durch actor-only Ereignisse entstehen: Der Client darf nie fehlende private Inhalte rekonstruieren, sondern lädt `room:sync` oder den REST-Snapshot. Start-/terminale Game-Events tragen vollständige Snapshots; jede andere zulässige Delta-Anwendung muss den resultierenden Stand erneut gegen `GameSnapshotSchema` validieren. Ack und Live-Event derselben Aktion werden dedupliziert.

## Idempotenz und Versionen

- `(actorUserId, operation, aggregateId, clientRequestId)` mit Payload-Hash schützt den Command. Gleicher Retry verhindert Mutation/Event/Version/Provideraufruf erneut und liefert den erneut autorisierten logischen Erfolgsverweis statt automatisch historischer fetter DTOs.
- `room:leave`, Invitation-Rotation, Start, Befragung und Finale verlangen `expectedVersion`. Create, Join und Chat sind dokumentierte Ausnahmen.
- In-flight Requests mit demselben Key werden zusammengeführt. Bei Schlüsselgleichheit und unterschiedlichem Payload entsteht `IDEMPOTENCY_KEY_REUSED`.
- Kein Ack-Timeout beweist einen Fehlschlag. Client synchronisiert regulär und nutzt beim identischen Retry denselben Key. Ein unbestätigter Leave ist die Ausnahme: derselbe Leave wird direkt wiederholt, ohne zuvor Mitgliedschaft/Room-Snapshot anzufordern. Sein exakter Receipt darf nach Austritt ausschließlich `{ roomId, roomVersion, closed }` ohne fette Daten erneut liefern.
- Historische Receipts kürzen keine aktuelle Berechtigungsprüfung für reichhaltige Daten. Nur minimale Leave-/Secret-Replay-Marker sind als Ausnahmen erlaubt.
- Replays gelten während der Receipt-Aufbewahrung ihres Aggregats; nach Cleanup gibt es keine Klartext- oder unbegrenzte Replay-Rekonstruktion.

## Startkonsistenz

- Der erste eindeutige Session-Insert enthält `startIntent` mit Actor, Room, Request-ID, Payload-Hash, erwarteter Room-Version, Case/Version und internem `pending`. Diese internen Zustände sind keine öffentliche Session.
- Nur exakt identische Requests setzen `pending`/`prepared` fort. Andere Pending-Starts liefern `OPERATION_IN_PROGRESS`; abweichender Payload im selben Scope `IDEMPOTENCY_KEY_REUSED`.
- Der Room-CAS verlinkt `activeSessionId`, `in_progress`, Start-Receipt und Versionsinkrement. Erst danach gibt es Broadcast/Ack und eine lesbare Game Session. Definitive CAS-Verluste erzeugen `VERSION_CONFLICT`/Superseding statt sichtbarem Start; nie verknüpfte Intents werden erst nach kontrolliertem Ablauf bereinigt.

## Fehlerfälle

| Fall | Vertragliches Verhalten |
|---|---|
| Raum voll | `ROOM_FULL`; exakter Join-Replay/No-op bestehender Mitglieder bleibt idempotent ohne neue Version |
| Code ungültig/abgelaufen | `INVITATION_INVALID`, außer exakter eigener Join-Receipt mit noch aktiver Mitgliedschaft |
| Nicht Mitglied | `NOT_FOUND`; keine Rich-Raum-/Sessiondaten trotz historischem anderen Receipt |
| Keine Hostberechtigung | `FORBIDDEN`, sofern der Raum sichtbar ist; ohne passenden Secret-Receipt keine Rotation |
| Create/Rotate-Response verloren | codefreie `SecretReplayResponse`, keine Version/Rotation; bei Bedarf neue Request-ID rotieren |
| Host verlässt Lobby | atomare Raumschließung, `room:closed` an befugte Empfänger |
| Mitglied verlässt Lobby | Mitglied entfernen, Room-Version +1, `room:member-left` |
| Leave-Ack nach Austritt verloren | identischer direkter Retry liefert nur minimales Leave-Ack aus eigenem Receipt, kein Snapshot |
| Leave nach Start neuer Request | `INVALID_STATE_TRANSITION`; Disconnect bleibt nur Offline-Präsenz |
| Fremder Pending-Start | `OPERATION_IN_PROGRESS`, keine Intentübernahme; eigener exakter Retry setzt fort |
| Event doppelt gesendet | erneut autorisierter Receipt-/Ergebnisverweis, keine zweite Mutation/Broadcast |
| Veraltete Version | `VERSION_CONFLICT` mit `currentVersion`, danach Snapshot |
| Eventlücke/Schemafehler | Delta nicht anwenden; Snapshot-Synchronisation |
| Payload zu groß | `PAYLOAD_TOO_LARGE`; keine Verarbeitung |
| Zu viele Aktionen | `RATE_LIMITED`, REST mit `Retry-After` |

## Sicherheitsfälle

- Fremde Mitglieder-, Session- und private Eventdaten werden niemals als vollständiges Fremdobjekt mit anschließendem Client-Filtering gesendet. Der Server erzeugt die Sicht vor dem Emit.
- Ein actor-only Ereignis wird nur an den Actor gesendet. Andere Raummitglieder erhalten allenfalls sichtbare öffentliche Effekte und können Versionssprünge beobachten, niemals private Payloads.
- Einladungscodes erscheinen nicht in Receipts, Replays, Room-Snapshots, Raumevents oder Logs. Rotation invalidiert den alten Hash sofort, erhöht die Room-Version einmal und sendet `room:invitation-rotated` ohne Code.
- Host-/Mitgliederänderungen und Start werden serverseitig validiert. Clientseitig deaktivierte Buttons sind keine Sicherheitsgrenze.
