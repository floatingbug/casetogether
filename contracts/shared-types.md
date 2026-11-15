# Shared Contracts

Status: T001-Architektur-/Vertrags-Freeze; einschließlich dokumentierter Einschränkungen und Folgezuordnungen durch Nutzer am 2026-11-15 für die nachfolgende Umsetzung freigegeben.

Dieses Dokument ist die framework-neutrale Referenz für die TypeScript-Typen und Zod-Schemas in `packages/shared`. T002 bildet die hier genannten Schemas ohne fachliche Abweichung ab. REST-Transportdetails stehen zusätzlich normativ in `contracts/openapi.yaml`, Socket-Transportdetails in `contracts/events.md`.

## 1. Vertrags- und Validierungsregeln

- Alle ids sind fachlich opaque Strings. Clients dürfen weder Datenbankformat noch Sortierung oder Inhalt aus einer ID ableiten.
- Öffentliche DTOs enthalten keine MongoDB-Dokumente, internen Feldnamen, Passwort-/Token-Material, geheimen Fallregeln oder nicht autorisierten Spielerinformationen.
- Alle eingehenden HTTP- und Socket-Payloads werden an der Systemgrenze mit Zod validiert. Request-Schemas sind `strict()`; unbekannte Felder werden abgelehnt, nicht stillschweigend durchgereicht.
- Auch Datenbank- und LLM-Grenzen validieren mit `unknown` als Ausgangstyp. Client-DTOs werden durch eigene Output-Schemas erzeugt und nicht durch Type Assertions aus Persistenzobjekten erzeugt.
- Strings werden vor fachlicher Validierung getrimmt und als Unicode NFC normalisiert, sofern unten nicht anders angegeben. Passwörter werden **nicht** getrimmt oder normalisiert.
- Server-Zeitstempel sind UTC-ISO-8601 Strings mit `Z`, Millisekunden und `date-time`-Semantik. Der Client akzeptiert RFC-3339-Zeitstempel, rendert Zeiten lokal und erzeugt keine autoritativen Server-Zeitstempel.
- Ganzzahlige Versionen und Bewertungen verwenden sichere JSON-Integer. Versionen werden niemals clientseitig fortgeschrieben und als autoritativ akzeptiert.
- Normative Schema-Namen enden auf `Schema`, der abgeleitete TypeScript-Typ auf den jeweiligen DTO-Namen. Die Markdown-Deklarationen beschreiben die zu exportierenden Typen; sie sind keine zweite, abweichende Implementierung.

## 2. Primitive und Zod-Regeln

| Schema / Typ | Verbindliche Regel |
|---|---|
| `OpaqueIdSchema` | String, 1–64 Zeichen, Regex `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` |
| `UserIdSchema`, `RoomIdSchema`, `CaseIdSchema`, `SessionIdSchema`, `SuspectIdSchema`, `QuestionIdSchema`, `ClueIdSchema`, `EventIdSchema`, `MessageIdSchema`, `DialogueIdSchema` | jeweils `OpaqueIdSchema`; TypeScript-seitig als voneinander nicht zuweisbare Brands |
| `CaseVersionSchema` | semantische Version als String, Regex `^\d+\.\d+\.\d+$`; beim Spielstart fixiert |
| `ClientRequestIdSchema` | UUID v4; vom Client pro logischer Aktion erzeugt; identischer Retry behält denselben Wert |
| `IsoDateTimeSchema` | RFC-3339 `date-time`; Server-Ausgabe immer UTC mit `Z` |
| `EmailSchema` | getrimmt, lowercase, Zod-E-Mail-Validierung, max. 254 Zeichen |
| `PasswordSchema` | String, 12–128 Zeichen; kein Trimmen; keine erzwungenen Zeichenklassen |
| `DisplayNameSchema` | NFC + Trim, 1–32 Zeichen, keine Steuerzeichen |
| `ChatContentSchema` | NFC + Trim, 1–1000 Zeichen |
| `FreeTextQuestionSchema` | NFC + Trim, 1–500 Zeichen |
| `DialogueTextSchema` | NFC + Trim, 1–4000 Zeichen |
| `VersionSchema` | Integer, min. 1 |
| `InvitationCodeSchema` | 12 kryptografisch zufällige Zeichen aus `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, gruppiert als `XXXX-XXXX-XXXX`; 60 Bit Entropie |

`QuestionId` adressiert innerhalb einer fixierten `CaseVersion` genau eine kuratierte Frage samt Referenzantwort und deterministischer Engine-Auswertung. Eine ID oder Referenzantwort wird niemals aus Modelltext erzeugt.

## 3. Fehler- und Antworthüllen

Alle nicht leeren REST-Erfolgsantworten haben die Form `{ "data": T }`. `204 No Content` hat keinen Body. Socket.IO verwendet die Acknowledgements aus `contracts/events.md`.

```ts
interface ApiError {
  code: ErrorCode;
  message: string;             // verständlich, ohne interne Details; Clients verzweigen auf code
  requestId: string;           // serverseitige Korrelations-ID, kein Auth- oder Spielgeheimnis
  details?: ErrorDetails;
}

interface ErrorDetails {
  fieldErrors?: Array<{ path: string; code: string }>; // keine Eingabewerte oder Secrets
  retryAfterSeconds?: number; // Integer >= 1
  currentVersion?: number;    // aktuelle autoritative Version bei VERSION_CONFLICT
}

interface ErrorResponse {
  error: ApiError;
}
```

`ErrorCode` und HTTP-Verwendung:

| Code | HTTP | Bedeutung |
|---|---:|---|
| `VALIDATION_ERROR` | 400 | Schema oder fachliches Eingabeformat ungültig |
| `UNAUTHENTICATED` | 401 | Auth-Cookie fehlt, ist ungültig oder abgelaufen |
| `INVALID_CREDENTIALS` | 401 | Login generisch abgelehnt; kein Hinweis auf Kontoexistenz |
| `CSRF_REJECTED` | 403 | Origin-/Fetch-Site-/JSON-Schutz bei unsicherer REST-Anfrage nicht bestanden |
| `FORBIDDEN` | 403 | Authentifiziert, aber Rolle/Aktion nicht erlaubt |
| `NOT_FOUND` | 404 | Ressource nicht vorhanden **oder** nicht für den Aufrufer sichtbar |
| `EMAIL_ALREADY_REGISTERED` | 409 | Registrierung mit bereits registrierter E-Mail |
| `INVITATION_INVALID` | 400 | Einladungscode ungültig oder abgelaufen; keine Differenzierung nach außen |
| `ROOM_FULL` | 409 | Vier aktive Mitglieder; erneuter Join eines bestehenden Mitglieds bleibt idempotent |
| `ROOM_NOT_JOINABLE` | 409 | Raum akzeptiert im aktuellen Zustand keine neuen Mitglieder |
| `ROOM_CLOSED` | 410 | Ehemals sichtbarer Raum wurde explizit geschlossen |
| `QUESTION_NOT_AVAILABLE` | 409 | Katalogfrage gehört nicht zum Fall/Verdächtigen oder ist für diesen Spieler nicht freigeschaltet |
| `INVALID_STATE_TRANSITION` | 409 | Aktion ist in der aktuellen Raum-/Sessionphase nicht erlaubt |
| `VERSION_CONFLICT` | 409 | `expectedVersion` ist veraltet; `details.currentVersion` enthält den aktuellen Stand |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Derselbe Idempotenz-Scope wurde mit abweichendem Payload verwendet |
| `OPERATION_IN_PROGRESS` | 409 | Ein anderer Start/Request hält denselben Aggregat-Scope vorübergehend; eigener identischer Request setzt seinen `startIntent` fort |
| `RATE_LIMITED` | 429 | Limit erreicht; REST setzt zusätzlich `Retry-After` |
| `PAYLOAD_TOO_LARGE` | 413 | HTTP-/Socket-Größenlimit überschritten |
| `AI_UNAVAILABLE` | 503 | Nur optionale Freitext-KI nicht verfügbar/ungültig; Katalogaktionen verwenden stattdessen Referenzfallback |
| `INTERNAL_ERROR` | 500 | Nicht näher offengelegter Serverfehler; nur `requestId` korreliert Logs |

Validierungs-, Authz- und Ressourcenfehler dürfen keine geheimen Fallinformationen, Passwörter, Cookies, Codes oder vollständigen Dialoginhalte in `details` zurückgeben.

## 4. Identität und Räume

```ts
type RoomStatus = 'waiting' | 'ready' | 'in_progress' | 'closed';
type RoomRole = 'host' | 'member';
type PresenceStatus = 'online' | 'offline';

interface PublicUser {
  id: UserId;
  displayName: string;
}

interface RoomMember {
  user: PublicUser;
  role: RoomRole;
  joinedAt: string;
}

interface RoomSummary {
  id: RoomId;
  status: RoomStatus;
  version: number;
  host: PublicUser;
  members: RoomMember[];       // eindeutig nach user.id, 1–4 im Bestand; Start nur mit 2–4
  maxPlayers: 4;
  activeSessionId: SessionId | null;
  createdAt: string;
  expiresAt: string;           // Ablauf einer noch nicht gestarteten Lobby
}

interface ChatMessage {
  id: MessageId;
  roomId: RoomId;
  sender: PublicUser;
  content: string;
  createdAt: string;
}

interface PresenceMember {
  userId: UserId;
  status: PresenceStatus;
  changedAt: string;
}

interface RoomSnapshot {
  room: RoomSummary;
  recentMessages: ChatMessage[]; // maximal 50, aufsteigend nach createdAt/id; nur Raummitglieder
  presence: PresenceMember[];    // flüchtig, keine persistente Room-Version
}

interface Invitation {
  code: string;                // InvitationCodeSchema; nur direkt nach Erzeugung/Rotation
  expiresAt: string;
}

type SecretReplayRecovery = 'rotate_with_new_client_request_id_if_needed';

interface SecretReplayResponse {
  outcome: 'replayed';
  roomId: RoomId;
  invitation: null;
  recovery: SecretReplayRecovery;
}

interface CreatedRoomResponse extends RoomSnapshot {
  outcome: 'created';
  invitation: Invitation;
}

type CreateRoomResponse = CreatedRoomResponse | SecretReplayResponse;

interface RotatedInvitationResponse {
  outcome: 'rotated';
  room: RoomSummary;
  invitation: Invitation;
}

type RotateInvitationResponse = RotatedInvitationResponse | SecretReplayResponse;
```

Der Einladungscode ist **Mitglieder-privat** und kein Bestandteil von `RoomSummary` oder Broadcasts. Da nur sein Hash gespeichert wird, ist er nachträglich nicht abrufbar. Der Host kann ihn über den Rotation-Endpunkt ersetzen. `RoomSnapshot` selbst ist nur für Mitglieder sichtbar; „public“ bedeutet in diesem Vertrag stets raumöffentlich, nicht Internet-öffentlich.

**Ausnahme für verlorene Secret-Responses:** Nur die erste erfolgreiche Create-/Rotate-Response (`outcome = created | rotated`) enthält `Invitation.code`. Der Idempotenz-Receipt speichert ausschließlich die `roomId`, Payload-/Key-Hashes und den nichttextuellen Erfolgsverweis, niemals Code oder vollständige Secret-Response. Geht diese erste Response verloren, liefert ein authentifizierter persistenter Replay mit identischem Key/Payload die diskriminierte `SecretReplayResponse` mit `outcome = replayed`, `invitation = null` und `recovery = rotate_with_new_client_request_id_if_needed`. Create antwortet initial `201`, der sichere Replay `200`; Rotate unterscheidet beide Varianten ebenfalls über `outcome`. Der Host muss bei weiterhin benötigtem Code mit **neuer** `clientRequestId` rotieren und erhält dann nur dessen neuen Code in der ersten erfolgreichen Response. Ein Replay enthält weder alten noch neuen Code und erzeugt keine neue Rotation/Version.

## 5. Fall, Katalog und Sichtbarkeit

```ts
interface CaseSummary {
  id: CaseId;
  title: string;
  description: string;
  estimatedDurationMinutes: number; // Integer 5–240
}

interface CatalogQuestion {
  questionId: QuestionId;
  suspectId: SuspectId;
  text: string;                   // 1–500 Zeichen
}

interface PublicSuspect {
  id: SuspectId;
  displayName: string;
  publicDescription: string;
}

interface Clue {
  id: ClueId;
  title: string;
  text: string;
  discoveredAt: string;
}

type DialogueMode = 'catalog' | 'free_text';
type AnswerSource = 'reference' | 'ai' | 'fallback';

interface SuspectDialogue {
  id: DialogueId;
  suspectId: SuspectId;
  mode: DialogueMode;
  questionId: QuestionId | null; // catalog: gesetzt; free_text: immer null
  questionText: string;
  answerText: string;
  answerSource: AnswerSource;     // free_text: nur ai
  askedBy: PublicUser;
  createdAt: string;
}
```

Sichtbarkeiten werden serverseitig als `room` oder `actor` gepflegt, aber **nicht** als Freitext-/Regelobjekte an Clients weitergereicht:

- `room`: Der Server darf das Feld an alle aktuellen Raummitglieder projizieren.
- `actor`: Nur der auslösende Spieler erhält die Frage, Antwort oder den Hinweis in seinem persönlichen DTO/Event.
- `server-secret`: Niemals Client-DTO oder optionaler LLM-Kontext, sofern nicht eine ausdrücklich kuratierte, für diesen Kontext freigegebene Ableitung vorliegt.

`availableQuestions`, `privateClues` und nicht raumöffentliche Dialoge sind daher **empfängerspezifische Projektionen**. Fragen enthalten keine Triggerbedingungen, Hinweisverknüpfungen oder Referenzantwort vor ihrer Beantwortung. Nicht freigeschaltete Fragen werden weggelassen, nicht nur als deaktiviert markiert.

## 6. Game Session

```ts
type GamePhase = 'investigating' | 'completed' | 'abandoned';
type FinalVerdict = 'correct' | 'incorrect';

interface FinalSubmission {
  suspectId: SuspectId;
  submittedBy: PublicUser;
  submittedAt: string;
}

interface CaseResolution {
  suspectId: SuspectId;
  title: string;
  explanation: string;
}

interface GameResult {
  verdict: FinalVerdict;
  awardedPoints: number;   // Integer >= 0, deterministisch aus Fallregeln
  maximumPoints: number;   // Integer >= awardedPoints
  feedback: string;
  resolution: CaseResolution;
}

interface GameSnapshot {
  sessionId: SessionId;
  roomId: RoomId;
  caseId: CaseId;
  caseVersion: string;
  phase: GamePhase;
  version: number;
  members: RoomMember[];
  suspects: PublicSuspect[];
  availableQuestions: CatalogQuestion[]; // nur aktuell für den Empfänger verfügbar
  publicClues: Clue[];
  privateClues: Clue[];                  // ausschließlich eigene private Hinweise
  dialogues: SuspectDialogue[];          // nur autorisierte Sicht, aufsteigend createdAt/id
  finalSubmission: FinalSubmission | null;
  result: GameResult | null;             // ausschließlich phase = completed
  startedAt: string;
  finishedAt: string | null;
}
```

Ein Spielstart erzeugt direkt `phase = investigating`. Eine finale Abgabe sperrt und bewertet die Gruppenlösung atomar und erzeugt `phase = completed`; es gibt keinen separaten Freitext- oder KI-Schritt vor der Auflösung. `abandoned` enthält keine Auflösung, sofern nicht ein später freigegebener Vertrag dies ausdrücklich ändert.

Jedes Mitglied darf nach Absprache in der Gruppe die gemeinsame finale Abgabe auslösen; ein Abstimmungs-/Voting-System ist nicht Teil des MVP. Der Server übernimmt ausschließlich `suspectId` und berechnet Wahrheit, Punkte, Feedback und Auflösung selbst.

## 7. Server-only und Datenklassifikation

| Klasse | Beispiele | Zulässige Weitergabe |
|---|---|---|
| Öffentlich innerhalb eines authentifizierten Raums | `PublicUser`, Raummetadaten, Fallzusammenfassung, `PublicSuspect`, raumöffentliche Fragen/Dialoge/Hinweise | Nur an Raummitglieder; niemals unselektiert aus kompletten Fall-/Sessiondokumenten |
| Player-private / Mitglieder-privat | E-Mail, eigene private Hinweise/Fragen/Dialoge, Auth-Status, Einladungscode beim Erstellen/Rotieren | Nur an betroffenen Nutzer bzw. berechtigten Host; keine fremden privaten Felder |
| Server-secret | Passwort- und Session-Hashes, Cookie-Signaturmaterial, komplette Wahrheit/Täter vor Auflösung, `SuspectSecret`, nicht freigegebene Referenzantworten/Trigger, Prompts, Provider-Schlüssel, Idempotenz-Payload-Hash | Server-only; kein Shared-Client-Export und kein Client-/Broadcast-Schema |
| Flüchtig | Socket-Verbindungen und Präsenz | Bereinigte Präsenz nur an Raummitglieder; keine Autorität oder persistente Spielversion |

Server-only Persistenztypen wie `CaseTruth`, `SuspectSecret`, `PrivateClueRule`, `EngineState`, `AuthSessionRecord` und `ProviderConfig` liegen im Backend und dürfen nicht in Client-DTO-Schemas importiert oder serialisiert werden. Erst nach `completed` darf die freigegebene `CaseResolution` als eigene Projektion an Raummitglieder ausgeliefert werden.

## 8. Grenzen, KI und Idempotenz

- Eine Katalogaktion benötigt ausschließlich `suspectId`, `questionId`, `clientRequestId` und `expectedVersion` zusätzlich zur Session. Weder Freitext noch Provider oder API-Schlüssel sind erforderlich.
- Die kanonische Engine-Auswertung erfolgt vor und unabhängig von einer optionalen KI-Formulierung. `answerSource` ändert niemals Hinweise, verfügbare Folgefragen, Phase, finale Bewertung oder Versionssemantik.
- Nach Annahme einer gültigen Katalogaktion liefern Providerfehler, Timeout oder ungültige Ausgabe `answerSource = fallback` und die vorhandene Referenzantwort. Die Aktion wird nicht doppelt ausgewertet.
- Eine optionale `free_text`-Aktion hat keine Engine-Wirkung und erzeugt keine Hinweise, Folgefragen oder finale Bewertung. Ohne verwertbare KI-Antwort antwortet sie mit `AI_UNAVAILABLE`; der Server erfindet keine Referenzaktion.
- Mutierende Raum-/Spielaktionen (Raum erstellen/beitreten/verlassen, Einladung rotieren, Start, Finale, Chat und Befragen) verwenden `clientRequestId` mit dem Scope `(actorUserId, operation, aggregateId, clientRequestId)`. Abweichende Payloads im selben Scope erzeugen `IDEMPOTENCY_KEY_REUSED`; erfolgreiche identische Wiederholungen liefern ihren autorisierten logischen Erfolgsverweis ohne neue Version oder Broadcast. Reiche Daten werden nur nach erneuter Berechtigungsprüfung projiziert. Die Secret-Replay-Ausnahme ist oben ausdrücklich diskriminiert.
- Raum- und Sessionversionen sind getrennte monoton steigende Integer. Versionssprünge dürfen durch nicht sichtbare private Ereignisse entstehen; Clients gleichen bei einer Lücke oder `VERSION_CONFLICT` den Snapshot über REST ab.

## 9. Feldübergreifende Zod-Refinements

Die Output-Mapper erzeugen diese Invarianten serverseitig; Schemas validieren sie zusätzlich. OpenAPI beschreibt die möglichen Felder, während die nachfolgenden fachlichen Regeln Zod-`superRefine` beziehungsweise diskriminierte Schemas verbindlich einschränken:

- `RoomSummary`: `maxPlayers` ist genau 4; `host.id` kommt genau einmal mit `role = host` in `members` vor; alle anderen Mitglieder haben `role = member`; `user.id` ist eindeutig. `waiting` hat genau ein Mitglied und `activeSessionId = null`, `ready` zwei bis vier und `activeSessionId = null`, `in_progress` zwei bis vier und eine gesetzte `activeSessionId`. `closed` akzeptiert keine neuen Aktionen und setzt `activeSessionId` nur dann, wenn der Raum bereits eine Session hatte.
- `GameSnapshot.phase`: Bei `investigating` sind `result = null`, `finalSubmission = null` und `finishedAt = null`. Bei `completed` sind `finalSubmission`, `result` und `finishedAt` gesetzt, `result.resolution` entspricht der freigegebenen Auflösung und `awardedPoints <= maximumPoints`. Bei `abandoned` sind `result = null` und `finishedAt` gesetzt; `finalSubmission` kann nur aus einer vor `abandoned` bereits persistierten fachlichen Historie stammen, im MVP-Flow ist es `null`.
- `SuspectDialogue`: `mode = catalog` verlangt eine `questionId`; `mode = free_text` verlangt `questionId = null` und `answerSource = ai`. Nur `catalog` darf `reference` oder `fallback` tragen. Der Server validiert zusätzlich, dass `fallback` exakt der autoritativen Referenzantwort und `questionText` dem freigegebenen Katalogtext entspricht.
- `GameResult`: `maximumPoints >= awardedPoints >= 0`; `verdict` wird ausschließlich aus der kanonischen Bewertung erzeugt. `CaseResolution.suspectId` gehört zur fixierten Fallversion und darf erst mit `completed` serialisiert werden.
- `SuspectQuestionRequest` und `GameEvent` sind diskriminierte Unions, keine optional zusammengewürfelten Objekte. Ein Client-Request muss genau zu einer Variante passen; zusätzliche Felder der anderen Variante machen ihn ungültig.
- `ApiError`: `fieldErrors` ist nur für `VALIDATION_ERROR`, `retryAfterSeconds` nur für `RATE_LIMITED` und `currentVersion` nur für `VERSION_CONFLICT` zulässig. Sensible Eingabewerte gehören nie in `fieldErrors`.
- Nur die Varianten `CreatedRoomResponse`/`RotatedInvitationResponse` von `CreateRoomResponse`/`RotateInvitationResponse` enthalten ein `Invitation`-Objekt und damit einen Code. `SecretReplayResponse` verlangt dagegen zwingend `outcome = replayed`, `invitation = null` und `recovery = rotate_with_new_client_request_id_if_needed`; eine `room`-/`recentMessages`-/`presence`-Projection gehört nicht zu dieser Replay-Variante. Kein Zod-Outputschema für Room-/Game-Snapshot oder Broadcast darf `Invitation` akzeptieren.

Zusätzlich gelten für die Serverprojektion: jedes Array mit IDs enthält keine doppelten IDs; Dialoge sind nach `(createdAt, id)` aufsteigend sortiert; `availableQuestions`, `privateClues` und `dialogues` enthalten ausschließlich autorisierte Elemente des Empfängers. Client-Outputschemas ersetzen diese Autorisierung nicht, machen Verletzungen aber im Test und an der Systemgrenze sichtbar.
