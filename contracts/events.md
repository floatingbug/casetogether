# Realtime Event Contract

Status: T001-Architektur-/Vertrags-Freeze; einschließlich dokumentierter Einschränkungen und Folgezuordnungen durch Nutzer am 2026-11-15 für die nachfolgende Umsetzung freigegeben.

Dieser Vertrag gilt für Socket.IO auf dem Standardpfad `/socket.io` im selben Backend-Prozess wie die REST-API. Alle genannten DTOs und Fehler folgen `contracts/shared-types.md`. Kein Socket-RPC ersetzt die Autorität der Application Use Cases.

## 1. Verbindung und Transport

- Der Browser verbindet sich mit `withCredentials: true`. Authentifizierung erfolgt über `ct_session`; `auth.token`, Query-Tokens, Local-Storage-Tokens und clientseitig behauptete User-IDs sind verboten.
- Handshake und Long-Polling prüfen denselben Origin-Allowlist-Eintrag wie REST. Fehlende/abweichende Origins, ungültige/revozierte/abgelaufene Sessions werden vor Raumbeitritt abgelehnt.
- Ein erfolgreicher Socket-Handshake verleiht noch keine Raum- oder Spielberechtigung. `room:join` wird nach jeder neuen Verbindung aufgerufen; jedes Event prüft erneut authentifizierten Nutzer und aktuelle Raummitgliedschaft.
- Serverseitiges Logout/Revocation trennt zugehörige Sockets. Ein Reconnect ist erst mit einer dann noch gültigen Session möglich.
- Socket.IO-Acknowledgements sind Pflicht für jeden hier definierten Client-Request. Das Ack-Timeout des Clients ist **kein** Beweis, dass eine Aktion fehlgeschlagen ist.
- Eingehende Events werden als `unknown` mit strikten Zod-Schemas validiert. Maximale Rohgröße je Anwendungs-Payload: 16 KiB; HTTP-/Socket-Server können kleinere Limits anwenden und melden `PAYLOAD_TOO_LARGE`.
- Ereignis- und Fehler-Payloads enthalten keine Passwörter, Cookies, Einladungscodes, Providerdaten, geheimen Trigger oder serverseitigen Rohtexte aus Prompts.

```ts
interface SocketAckSuccess<T> { ok: true; data: T }
interface SocketAckFailure { ok: false; error: ApiError; clientRequestId?: string }
type SocketAck<T> = SocketAckSuccess<T> | SocketAckFailure;
```

Fehler werden synchron zum verursachenden Command als `SocketAckFailure` zurückgegeben. `game:error` ist nur für serverseitig initiierte, nicht einem offenen Ack zuordenbare Fehler vorgesehen. Clients verzweigen auf `error.code`, niemals auf Fehlermeldungstext.

### 1.1 Handshake- und `connect_error`-Wire-Form

Origin- und Auth-Prüfung verwenden denselben serverseitigen Socket.IO-Handshake-Middlewarepfad für WebSocket und initialen Long-Poll; ein generischer Engine.IO-`allowRequest`-Ablehnungspfad darf diese fachlichen Fehler nicht ausgeben. Der Server übergibt einen `Error` mit der konstanten nicht sensitiven `message = "Handshake rejected"` und exakt folgender Datenstruktur:

```ts
interface HandshakeErrorData { error: ApiError }
// Socket.IO: connect_error.data = { error: ApiError }
// Long-Polling-HTTP-Body: { error: ApiError } (ErrorResponse aus Shared Contracts)
```

| Ursache | Long-Polling-Status | `data.error.code` |
|---|---:|---|
| Cookie/Session fehlt, Signatur ungültig, abgelaufen oder revoziert | 401 | `UNAUTHENTICATED` |
| `Origin` fehlt/ist nicht erlaubt oder Fetch Metadata ist cross-site | 403 | `CSRF_REJECTED` |
| Nicht klassifizierbarer Serverfehler | 500 | `INTERNAL_ERROR` |

Der Socket.IO-Handshake-Adapter muss diese HTTP-/`connect_error`-Abbildung ausdrücklich koppeln und testen; Status `400` mit freiem Fehlertext ist für diese drei Klassen kein freigegebenes Verhalten. Der Socket-Client validiert `connect_error.data` als `unknown` gegen `HandshakeErrorData`. Die `message` des transporteigenen Error-Objekts wird niemals ausgewertet. HTTP-Body und `connect_error.data` besitzen dieselbe `ErrorResponse`-Form. Die `requestId` unterstützt Serverkorrelation und wird niemals mit Spiel-/Auth-Secrets gefüllt.

## 2. Client → Server

### 2.1 `room:join` – Raumverbindung/Synchronisation herstellen

```ts
interface RoomJoinRequest { roomId: RoomId }
type RoomJoinAck = SocketAck<{
  room: RoomSnapshot;
  game: GameSnapshot | null;
  serverTime: string;
}>;
```

- Der Nutzer muss bereits über REST-Mitgliedschaft verfügen. Dieser Request akzeptiert **keinen** Einladungscode und erzeugt keine Mitgliedschaft.
- Der Server tritt dem autorisierten Socket.IO-Raum bei und liefert vollständige empfängerspezifische Snapshots. Wiederholte Aufrufe sind idempotent und verändern weder Room- noch Sessionversion.
- Bei `NOT_FOUND`/`UNAUTHENTICATED` verwirft der Client lokale Raum-/Spieldaten. `ROOM_CLOSED` löscht keine lokale Auditinformation außerhalb des aktiven Spiels, erlaubt aber kein erneutes Beitreten.

### 2.2 `room:sync` – Snapshot nach Lücke/Konflikt erneut laden

Payload und Ack sind identisch zu `room:join`. Er kann auf derselben Verbindung nach einer Eventlücke oder einem `VERSION_CONFLICT` aufgerufen werden. Alternativ kann der Client die freigegebenen REST-Snapshots laden; beide Wege verwenden denselben Use Case und dieselbe Projektion.

### 2.3 `room:leave` – Lobby vor Spielstart verlassen

```ts
interface RoomLeaveRequest {
  roomId: RoomId;
  clientRequestId: string;
  expectedVersion: number;
}
type RoomLeaveAck = SocketAck<{
  roomId: RoomId;
  roomVersion: number;
  closed: boolean;
}>;
```

- Nur in `waiting`/`ready` erlaubt. Ein gewöhnliches Mitglied wird entfernt; verlässt der Host, wird der Raum für alle geschlossen. In `in_progress` erzeugt der Command `INVALID_STATE_TRANSITION`; ein Verbindungsabbruch ist niemals ein fachliches Verlassen.
- Erfolgreiche Mutation erhöht die Room-Version einmal. Ein authentifizierter Same-Request-Replay liefert das gespeicherte minimale Ack `{ roomId, roomVersion, closed }` ohne erneutes Event. Der Replay wird über `(actorUserId, operation, roomId, clientRequestId)` **vor** der erneuten Membership-Prüfung erkannt und darf danach auch vom inzwischen ausgetretenen Nutzer empfangen werden; er enthält keine Room-Snapshot-, Mitglieder-, Chat- oder Spieldaten. Ohne passenden Receipt gelten aktuelle Mitgliedschaft und `expectedVersion` erneut. Verbleibende Mitglieder erhalten `room:member-left` beziehungsweise `room:closed`; der ausgetretene Socket verlässt den Socket.IO-Raum. Die Receipt-/Replay-Reihenfolge in Abschnitt 4 ist verbindlich.
- Socket.IO-`disconnect` allein ändert nur Präsenz, niemals Mitgliederliste, Hostrolle oder Spielzustand.

### 2.4 `chat:send` – Raumchat senden

```ts
interface ChatSendRequest {
  roomId: RoomId;
  clientRequestId: string;
  content: string; // ChatContentSchema, 1–1000 Zeichen
}
type ChatSendAck = SocketAck<{ message: ChatMessage }>;
```

- Nur Mitglieder in `waiting`, `ready` oder `in_progress`. Der Text wird in `messages` gespeichert, bevor `chat:message` gesendet wird.
- Idempotenzschlüssel: `(senderUserId, 'chat:send', roomId, clientRequestId)`. Ein Replay liefert dieselbe `message.id` ohne neuen Broadcast.
- Chat hat keine `expectedVersion` und verändert weder Room- noch Game-Version. IDs und `(createdAt, id)` liefern die deterministische Anzeige-Chronologie; Clients deduplizieren zusätzlich mit der Message-ID.

### 2.5 `suspect:question` – Befragen mit zwei diskriminierten Modi

Beide Varianten sind nur in `investigating` erlaubt und autorisieren `sessionId`, Raummitgliedschaft, Verdächtigen und konkrete Sichtbarkeit serverseitig. Der Client darf weder Antwortquelle, Hinweise, Bewertung noch Auflösung übergeben.

```ts
interface QuestionRequestBase {
  sessionId: SessionId;
  clientRequestId: string;
  expectedVersion: number;
  suspectId: SuspectId;
}

interface CatalogQuestionRequest extends QuestionRequestBase {
  mode: 'catalog';
  questionId: QuestionId;
}

interface FreeTextQuestionRequest extends QuestionRequestBase {
  mode: 'free_text';
  questionText: string; // FreeTextQuestionSchema, 1–500 Zeichen
}

type SuspectQuestionRequest = CatalogQuestionRequest | FreeTextQuestionRequest;
type SuspectQuestionAck = SocketAck<{ event: GameEvent }>;
```

#### `mode: catalog` – vollständig spielbarer Basispfad

1. Einmalig in-flight gleiche Requests auf dem idempotenten Schlüssel werden zusammengeführt; eine bereits erfolgreiche Ausführung verwendet ihr Receipt.
2. Server validiert `questionId` gegen fixierte `CaseVersion`, `suspectId`, aktuelle Phase und empfängerspezifische Freischaltung. Ungültige Fragen liefern `QUESTION_NOT_AVAILABLE`, ohne Referenzantwort/Trigger preiszugeben.
3. Die Engine berechnet Referenzantwort, öffentliche/private Hinweise, Folgefragen und übrige zulässige Änderungen deterministisch und ohne Provider.
4. Ohne Provider wird sofort `answerSource = reference` verwendet. Mit Provider darf nur der sichtbare Text aus dem freigegebenen Kontext formuliert werden. `answerSource = ai` kennzeichnet validierte KI-Formulierung.
5. Timeout, Providerfehler oder ungültige Formulierung erzeugen `answerSource = fallback` mit exakt der Referenzantwort. Es gibt keinen erzwungenen Provider-Retry und keine erfundene Ersatzaktion.
6. Erst der atomare CAS-Schreibzugriff macht die Aktion erfolgreich. State, Dialog, Receipt, persistierte Eventrohdaten und genau eine Versionserhöhung werden gemeinsam gespeichert. Bei einem CAS-Verlust entsteht kein Broadcast; der Client erhält `VERSION_CONFLICT`.
7. Der Server sendet `game:event` mit `type = suspect.answered` in berechtigter Projektion. Das Ack enthält dasselbe logische `event`; ein Replay desselben Acks sendet nicht erneut an andere Empfänger.

Hinweise, Folgefragen, Phase und spätere Bewertung sind bei `reference`, `ai` und `fallback` identisch. `answerSource` ist nur transparente Darstellungsmetadaten und kein Engine-Input.

#### `mode: free_text` – optionale KI-Erweiterung, nicht abschlussrelevant

- Diese Variante besitzt **keine** `questionId` und keine Engine-Auswertung. Sie kann keine Hinweise, Folgefragen, Bewertung oder Phasen freischalten und ist niemals für den Fallabschluss erforderlich.
- Ohne aktivierten Provider, nach Timeout/Providerfehler oder bei ungültiger Modellausgabe liefert der Command `AI_UNAVAILABLE`. Es wird keine Katalogfrage erraten und keine Referenzantwort erfunden. Der vollständige `catalog`-Pfad bleibt nutzbar.
- Die Antwort muss dem Server-Schema genügen und ausschließlich aus minimiertem, serverseitig freigegebenem Charakterkontext formuliert werden. Spielertext ist untrusted Datum und kein Systemprompt. Modellseitig behauptete Fakten/State-Patches werden verworfen.
- Erfolgreiche freie Dialoge werden ausschließlich mit Sichtbarkeit `actor` gespeichert und nur an den fragenden Spieler als `suspect.free_text_answered` gesendet. Die Dialogspeicherung erhöht die Sessionversion um eins, ändert aber **keinen** Engine-State.
- Kosten-/Rate-/Längenlimits gelten zusätzlich zum allgemeinen Event-Limit. Verschlüsselte Provider-Secrets, vollständige Prompts und Rohtextausgaben werden nicht geloggt.

Es gibt absichtlich kein generisches `game:action` und keinen Payload `{ action: { type: string, ... } }` im MVP. Neue Spielaktionen benötigen einen diskriminierten, versionierten Vertrag und gegebenenfalls ein ADR.

## 3. Server → Client

Alle Anwendungs-Payloads werden serverseitig vor dem Senden und clientseitig vor der Anwendung mit den entsprechenden Output-Schemas validiert.

### 3.1 `room:snapshot`

```ts
interface RoomSnapshotEvent {
  snapshot: RoomSnapshot;
  emittedAt: string;
}
```

Vollständiger mitgliedschaftsbereinigter Ersatz eines lokalen Raumzustands, falls einzelne Raumereignisse nicht sicher angewandt werden können. Enthält **nie** einen Einladungscode. Niedrigere Room-Versionen ersetzen keinen neueren Bestand.

### 3.2 `game:snapshot`

```ts
interface GameSnapshotEvent {
  snapshot: GameSnapshot;
  emittedAt: string;
}
```

Empfängerspezifischer vollständiger Spielstand nach Reconnect, manueller Serverkorrektur oder auf synchronisierte Room-Anfrage hin. Private Fragen, Hinweise und Dialoge stammen ausschließlich aus der Sicht des Empfängers.

### 3.3 `room:presence`

```ts
interface RoomPresenceEvent {
  roomId: RoomId;
  members: PresenceMember[]; // vollständiger Präsenzstand, genau ein Eintrag je Raummitglied
  emittedAt: string;
}
```

Präsenz ist flüchtig und unversioniert. Der Client ersetzt den kompletten Präsenzstand, dedupliziert nach `userId` und verwendet `changedAt` nur zur Darstellung/Alterserkennung. Kein Präsenz-Event verändert Hostrolle oder Spielversion.

### 3.4 Raum-Ereignishülle

```ts
interface RoomEventBase<T extends string, P> {
  eventId: string;
  roomId: RoomId;
  version: number; // neue autoritative Room-Version
  type: T;
  occurredAt: string;
  payload: P;
}
```

| Socket.IO-Event | `type` | `payload` |
|---|---|---|
| `room:member-joined` | `room.member_joined` | `{ member: RoomMember }` |
| `room:member-left` | `room.member_left` | `{ userId: UserId; status: 'waiting' \| 'ready' }` |
| `room:closed` | `room.closed` | `{ reason: 'host_left' \| 'expired' }` |
| `room:invitation-rotated` | `room.invitation_rotated` | `{ expiresAt: string }`; nie Hash, Klartextcode oder Receipt |
| `room:started` | `room.started` | `{ sessionId: SessionId }`; immer vor dem zugehörigen `game.started` |

Raummitglieder wenden eine Version nur bei `localVersion + 1` direkt an. Bei älteren Duplikaten verwerfen sie das Event, bei Lücken synchronisieren sie den Raum neu. `room:started` enthält keine Case-Wahrheit oder Referenzantworten. Die codesfreie `room:invitation-rotated`-Benachrichtigung verhindert vermeidbare Versionslücken nach Rotation; der Host verwirft ihr Duplikat zu seiner bereits erhaltenen REST-Version über dieselbe Versionsregel. Präsenz und Chat besitzen bewusst keine Room-Version.

### 3.5 `chat:message`

```ts
interface ChatMessageEvent { message: ChatMessage }
```

Erst nach erfolgreicher Nachrichtenpersistenz an aktuelle Raummitglieder. Der Client dedupliziert gegen Snapshot und andere Live-Nachrichten anhand `message.id`; Sortierung `(createdAt, id)`.

### 3.6 Spiel-Ereignishülle

```ts
interface GameEventBase<T extends string, P> {
  eventId: string;          // serverseitig eindeutig; zusammen mit sessionId deduplizieren
  sessionId: SessionId;
  version: number;         // neue autoritative Sessionversion
  type: T;
  occurredAt: string;
  payload: P;              // bereits spezifisch für den Empfänger projiziert
}

type GameEvent =
  | GameEventBase<'game.started', { snapshot: GameSnapshot }>
  | GameEventBase<'suspect.answered', {
      dialogue: SuspectDialogue | null;
      newPublicClues: Clue[];
      newPrivateClues: Clue[];
      availableQuestions: CatalogQuestion[];
      phase: 'investigating'; // Katalogaktionen erzeugen niemals selbst einen terminalen Übergang
    }>
  | GameEventBase<'suspect.free_text_answered', {
      dialogue: SuspectDialogue; // ausschließlich an actor
    }>
  | GameEventBase<'game.completed', {
      snapshot: GameSnapshot; // vollständiger empfängerspezifischer Stand inkl. finishedAt/result/finalSubmission
    }>
  | GameEventBase<'game.abandoned', {
      snapshot: GameSnapshot; // vollständiger Stand inkl. finishedAt, result null und ohne Auflösung
    }>;
```

Projektionsregeln:

- `game.started` enthält den vollständigen Snapshot des jeweiligen Empfängers mit Version 1. Entsprechende Raumverknüpfung wurde zuvor gespeichert und per `room:started` gemeldet.
- Bei `suspect.answered` sind alle Arrays vollständig autorisiert; `availableQuestions` ist der aktuelle komplette Katalogausschnitt **dieses Empfängers**. `dialogue` ist `null`, wenn raumöffentliche Effekte gemeldet werden müssen, der auslösende Dialog aber nur für den Actor sichtbar ist. Sind weder Dialog noch Effekte für jemanden sichtbar, erhält diese Person kein Event.
- `newPublicClues` enthält nur in dieser Aktion neu entdeckte Raumhinweise, `newPrivateClues` ausschließlich neue eigene Hinweise. Bereits vorhandene Hinweise werden nicht erneut als neu ausgegeben.
- `suspect.free_text_answered` ist actor-only, macht keine Engine-Änderung und wird nicht an andere Mitglieder gesendet. Deren Versionszahlen dürfen daher springen.
- `game.completed` wird mit vollständigem empfängerspezifischem Snapshot an alle Raummitglieder gesendet; erst diese Projection darf `CaseResolution` enthalten. `game.abandoned` ersetzt den Stand ebenfalls vollständig und enthält `finishedAt`, `result = null` und keine Auflösung. Dadurch enthalten terminale Delta-Events niemals unvollständige Snapshot-Invarianten.
- Persistiert werden öffentliche und private Rohdaten nur serverseitig. Ein Broadcast-Payload wird erst nach Persistenz empfängerspezifisch projiziert und niemals als gemeinsames Objekt mit anschließendem Client-Filtering übergeben.

Versionsregeln:

1. Dasselbe `(sessionId, eventId)` wird ignoriert, wenn es bereits angewandt wurde; ebenso Events mit `version <= localVersion`.
2. `version === localVersion + 1` darf nach Payloadvalidierung angewendet werden. Snapshot-Events (`game.started`, `game.completed`, `game.abandoned`) ersetzen den kompletten lokalen Stand. Für die beiden `suspect.*`-Deltas wird ein neuer Kandidat gebaut (Version/Dialog/Hinweise/Fragen/phase nur laut Payload) und **vollständig gegen `GameSnapshotSchema` validiert**, bevor er sichtbar wird. `suspect.answered.phase = investigating` ist invariant; ein anderes Feld ist kein zulässiger Katalogoutput.
3. `version > localVersion + 1`, ein Schemafehler oder ein unvollständiges Delta bedeutet Lücke beziehungsweise nicht sichtbares/ungültiges Ereignis: Delta **nicht** auf veralteten Bestand anwenden, sondern `room:sync`/`GET /sessions/{sessionId}` ausführen und danach mit dem Snapshot ersetzen.
4. Snapshot-Ersetzung ist nur mit gleicher/höherer Version zulässig. Empfangene alte Acks oder Snapshots dürfen neueren State nicht zurückdrehen.
5. Das Ack einer Befragung trägt dasselbe Event wie die Originalpersistierung. Es wird zusätzlich nach `eventId`/Version dedupliziert; Replay erzeugt kein neues Event.

### 3.7 `game:error`

```ts
interface GameErrorEvent {
  error: ApiError;
  clientRequestId?: string;
}
```

Nur für nicht einem offenen Ack zugeordnete serverseitige Fehler; niemals Broadcast eines fremden Fehlers. Kein Stacktrace, Prompt, Provider-Secret, Antwortentwurf oder fremder privater Kontext. Socket.IO-`connect_error` folgt ausschließlich der Wire-Form aus Abschnitt 1.1.

## 4. Retry, Reconnect und Client-Reihenfolge

1. Vor jeder Verbindung verwirft der Client keine unbestätigte `clientRequestId`; er markiert sie als „Ausgang unbekannt“.
2. Nach `connect` ruft er regulär `room:join` auf und ersetzt Room/Game mit den autoritäten Snapshots. **Ausnahme:** Bei einem unbestätigten `room:leave` darf ein zu erwartendes `NOT_FOUND` nach dem bereits erfolgten Austritt nicht als neue fachliche Ablehnung interpretiert werden. Der Client wiederholt stattdessen denselben Leave-Command direkt und nutzt den minimalen Receipt-Replay ohne vorherige Mitgliedschaft oder Room-Synchronisation.
3. Derselbe unbestätigte Command behält **dieselbe** `clientRequestId` und exakt denselben validierten Payload. Neue fachliche Aktionen und geänderte Payloads verwenden neue UUIDs. Create/Rotate laufen über REST; ihr identischer Retry hängt weder von Socket-`room:join` noch vom Erhalt des ersten Klartextcodes ab.
4. Der Server serialisiert identische in-flight Keys und prüft Receipt/Index atomar. Replay ruft weder Engine noch Provider erneut auf und verursacht keine zweite Nachricht, Versionserhöhung oder Eventverteilung.
5. `VERSION_CONFLICT` und Eventlücken werden durch Snapshot-Synchronisation behandelt. Ein clientseitiger manueller Retry nach Nutzerentscheid erfolgt mit neuer UUID und aktueller `expectedVersion`, sofern der Originalrequest nicht lediglich netzwerkbedingt unbestätigt ist. `OPERATION_IN_PROGRESS` erlaubt niemals die Übernahme eines fremden `startIntent`: Snapshotsynchronisation, späterer identischer eigener Request oder sicherer Cleanup sind vorgesehen.
6. Lokale Optimistik ist für finale Abgabe und Engine-Ergebnisse verboten. Optimistisch dargestellte Chat-/Frage-Pending-Zustände werden erst durch Ack/Event bestätigt und dürfen keine freigeschalteten Inhalte simulieren.

### 4.1 Serverseitige Receipt-/Autorisierungsreihenfolge

Authentifizierung und strikte Schema-/Größenvalidierung erfolgen immer zuerst. Ein Receipt wird nur für denselben authentifizierten `actorUserId` gelesen und niemals einem fremden Actor als Existenzbeweis angezeigt. Payload-Hash und vollständiger Idempotenz-Scope werden vor jeder Wiedergabe verglichen.

| Operation | Receipt-Suche und erlaubte Wiedergabe |
|---|---|
| Rich Room-/Game-/Chat-/Dialogdaten | Auch nach Receipt-Fund muss der Actor **jetzt noch** Mitglied sein; ein historisches Receipt macht keine früheren Fremd-/Raumdaten wieder sichtbar. Ohne aktuelle Mitgliedschaft folgt `NOT_FOUND`. |
| REST Join nach Rotation/Ablauf | Zuerst Index `(actionReceipts.actorUserId, actionReceipts.operation, actionReceipts.clientRequestId)` nach `join` und Payload-Hash des normalisierten Codes. Der Treffer hängt nicht mehr vom aktuellen `invitation.codeHash` ab. Nur bei weiterhin bestehender Mitgliedschaft wird derselbe logische Erfolg als **aktueller** autorisierter Room-Snapshot ohne Mutation ausgegeben; andernfalls `NOT_FOUND` statt historischer Daten. Ohne exakten Receipt gilt der normale Code-Join aus `specs/rooms-realtime.md`. |
| Socket Leave nach Austritt | Exaktes `(roomId, actorUserId, clientRequestId)` darf ohne aktuelle Mitgliedschaft das minimale Original-Ack `{ roomId, roomVersion, closed }` erneut liefern. Es enthält weder Snapshot noch freigeschaltete/private Daten. Ohne passenden Receipt gelten aktuelle Mitgliedschaft und Version. |
| REST Create ohne bekannten Raum | Suche per Actor, Operation `create` und Request-ID in den Room-Receipts. Exakter Replay liefert ausschließlich `SecretReplayResponse` mit `roomId`, `outcome`, `invitation = null` und `recovery`, niemals Mitglieder-/Chatdaten oder Klartextcode. |
| REST Rotate mit bekanntem Raum | Exakter historischer Host-Receipt darf vor neuer Host-/Membership-Prüfung ebenfalls ausschließlich die codefreie `SecretReplayResponse` liefern. Ohne passenden Receipt gelten aktuelle Hostrolle und Version. Ein Replay rotiert weder Code noch Version. |
| Start und übrige Spielaktionen | Aktuelle Host-/Mitgliedschaftsberechtigung bleibt vor jeder Ergebnisprojektion Pflicht. Ein vorhandener `startIntent` muss exakt zu Actor, Room, Request-ID und Payload-Hash passen; bei selbem Scope mit Abweichung gilt `IDEMPOTENCY_KEY_REUSED`, bei fremdem Pending-Start `OPERATION_IN_PROGRESS`. |

Replays werden nur solange der zugehörige Receipt laut `docs/DATABASE.md` aufbewahrt wird garantiert. Nach Cleanup existiert weder Klartextcode noch Receipt-Rekonstruktion; das erlaubt kein Klartextspeichern für ein längeres Idempotenzfenster.

Ein Replay darf sich durch flüchtige Daten in einer neu autorisierten Projektion von der ersten Response unterscheiden, niemals aber in logischem Erfolg, Identität, Mutation, Secret-Ausgabe oder Versionseffekt. Create/Rotate sind die einzigen Varianten, deren erste Response ein einmaliges Klartextsecret enthält und deren Replay deshalb zwingend codefrei ist.

## 5. Autorisierungs- und Leak-Matrix

| Aktion/Daten | Authentifiziert | Raummitglied | Zusatzregel |
|---|---:|---:|---|
| `room:join`, `room:sync` | ja | ja | empfängerspezifische Snapshots; nie Code-Join per Socket |
| `room:leave`, `room:closed` | ja | ja bzw. ehemalige Mitglieder beim Close | nur Lobby; Host schließt Raum |
| Chat | ja | ja | Room nicht closed; Rate Limit |
| Katalogfrage | ja | ja | Phase, Version, Suspect, freigeschaltete Frage, Receipt |
| Freitextfrage | ja | ja | zusätzlich Provider aktiviert sowie AI-Limits; actor-only Antwort |
| Raum-/Spiel-Broadcast | ja | aktuell bzw. beim Close bereits autorisiert | Payload pro Empfänger, keine fremden Privatdaten |
| `game.completed` | ja | ja | erst nach persistierter Bewertung; erst jetzt Auflösung |

Jeder Verstoß wird vor fachlicher Ausführung abgelehnt. Das bloße Beitreten eines Socket.IO-Raums oder eine vom Client gelieferte `sessionId` ersetzt keine dieser Prüfungen.
