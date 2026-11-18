# Spec: Security Boundaries

Verbindliche Details: ADR-001 bis ADR-003, `contracts/shared-types.md`, `contracts/openapi.yaml`, `contracts/events.md` und `docs/DATABASE.md`.

## 1. Autoritative Quellen

- Identity/Auth-Session: authentifizierte Nutzeridentität und Revocation
- Room-Service: Mitgliedschaft, Hostrolle, Join-/Leave-/Raumstatus
- Game Engine: Katalogsichtbarkeit, Fallwahrheit, Hinweise, Phasen, Bewertung und Auflösung
- Persistenz: Version, Event-/Nachrichten-ID und Idempotenz-Receipt
- Entitlement-Service (später): Kaufrechte, nicht MVP
- LLM: ausschließlich untrusted Dialogtext-Vorschlag; kein Fakten-/State-/Berechtigungsurteil

## 2. Authentifizierung und Session-Schutz

- Zufällige Auth-Session-IDs besitzen mindestens 256 Bit Entropie, werden mit `SESSION_SECRET` zweckgebunden HMAC-signiert und nur gehasht persistiert. Logout/Revocation und sieben Tage absoluter Ablauf werden serverseitig geprüft.
- Cookie `ct_session`: `HttpOnly`, `Path=/`, in Produktion `Secure`; `SameSite=Lax` in
  Entwicklung/Test, `SameSite=None` in Produktion für die getrennten Vercel-/VPS-Origins
  (ADR-004); kein Local-/Session-Storage, URL-Query oder Socket-Handshake-Body für Tokens.
- Unsafe REST verlangt Origin-Allowlist, geeignete Fetch Metadata und JSON. Diese Prüfungen sowie CORS werden serverseitig erzwungen und gelten auch für Socket-Handshake/Long-Polling.
- CORS verwendet exakte Origins und Credentials, niemals `*` mit Credentials. Die Frontend-Origin ist ein Konfigurationswert, kein clientautorisierender Beweis ohne Serververgleich.
- Socket-Verbindung wird beim serverseitigen Logout/Revocation getrennt. Auth beim Handshake ersetzt keine aktuelle fachliche Autorisierung bei jedem Command.
- Handshakefehler folgen exakt `contracts/events.md`: `connect_error.data = { error: ApiError }` und identischer Long-Polling-`ErrorResponse`. Signatur/Ablauf/Revocation ergibt 401/`UNAUTHENTICATED`, Origin/Fetch Metadata 403/`CSRF_REJECTED`, intern 500/`INTERNAL_ERROR`. Freie Transportfehler dürfen die Kategorie nicht verwässern.
- `SESSION_SECRET` hat mindestens 32 Byte Zufallsentropie, ist nicht im Frontend enthalten und nicht mit einem optionalen Provider-Key gleichzusetzen.

## 3. Credentials, Einladungen und Rate Limits

- Passwörter: 12–128 Zeichen bei Registrierung, kein Trimmen/NFC, Argon2id mit eigenem mindestens 128 Bit Salt; initial mindestens `m = 19456 KiB`, `t = 2`, `p = 1` oder die damals empfohlenen höheren OWASP-Werte. Parameter werden mit dem Hash versioniert und bei Login rehash-fähig geprüft.
- Login-Fehler sind generisch `INVALID_CREDENTIALS`; keine Kontoexistenz-, Provider- oder Hashdetails. Registrierung darf `EMAIL_ALREADY_REGISTERED` verwenden und muss trotzdem rate-limitiert sein.
- Einladungen besitzen 60 Bit Entropie, gruppierte Eingabe, Normalisierung für den Hash, 60 Minuten Gültigkeit und Rotation. `INVITATION_INVALID` unterscheidet außen weder falschen noch abgelaufenen Code. Nur die erste erfolgreiche Create-/Rotate-Response enthält Klartext; ein persistenter Replay enthält `invitation = null` und keinen ersatzweise erzeugten Code. Eine neue Rotation benutzt eine neue Request-ID.
- Initiale serverseitige Limits, sofern eine Umgebung nicht strengere sichere Werte setzt: Login/Registrierung 10 Requests/5 min/IP plus 5 Fehlversuche/15 min/Konto-Key; Raumbeitritt 10/5 min/Nutzer und 50/h/IP; Chat 10/10 s/Nutzer/Raum; Katalog 30/min/Nutzer/Session; Freitext 5/min und 20/Session/Nutzer.
- Konto-/IP-Schlüssel für Rate Limits werden nicht als Klartext-E-Mail oder unnötige dauerhafte Nutzerprofile geloggt. Limits müssen gegen Parallelität wirken. `429` enthält `retryAfterSeconds`, REST zusätzlich `Retry-After`.
- HTTP-/Socket-Anwendungspayload maximal 16 KiB; konkrete String-/Array-Grenzen der Shared Schemas gelten zusätzlich. Große Bodies werden möglichst vor dem Parsen abgelehnt.

## 4. REST- und Socket-Autorisierung

- Jeder Use Case bestimmt Actor ausschließlich aus gültiger Server-Session; Client-IDs in `submittedBy`, `sender`, `hostUserId`, Rollen oder Ownership-Feldern sind keine Autorität und in Request-Schemas nicht zugelassen.
- Jede Raumaktion prüft aktuelle Mitgliedschaft, Raumstatus und benötigte Rolle. Jede Sessionaktion prüft `session.roomId`, aktuelle Raummitgliedschaft und Phase.
- Fremde/nicht sichtbare Ressourcen liefern bevorzugt `NOT_FOUND`. Für sichtbare Ressourcen mit unzureichender Rolle ist `FORBIDDEN` zulässig.
- Socket.IO-Subscribe/`room:join` erfolgt erst nach Membership-Prüfung. Raumname, URL-Parameter und früherer Handshake ersetzen keine Prüfung pro Event.
- Nur Host startet, rotiert Einladungen und schließt beim Lobby-Verlassen. Jedes Mitglied darf finale Gruppenabgabe auslösen; Client darf Ergebnis nicht wählen.
- Serverseitige CAS-/Unique-Bedingungen verhindern doppelte Mutation auch dann, wenn Vorabautorisierung und Commit durch Parallelität auseinanderliegen. Join prüft Kapazität/Mitgliedschaft/Code/Status/Eindeutigkeit in einem atomaren Update; kein Vorabread allein.
- Receipt-Suche ist actor-gebunden und erfolgt erst nach Auth. Sie umgeht keine aktuelle Membership-Prüfung für reichhaltige Snapshots, Chat-/Dialog-/Eventinhalte. Exakt zwei minimalen Ausnahmen sind erlaubt: codefreie Create-/Rotate-`SecretReplayResponse` sowie Leave `{ roomId, roomVersion, closed }`. Join-Replay nach Rotation verlangt weiterhin aktuelle Mitgliedschaft.
- Ein vorhandener `startIntent` darf nur bei exakter Actor-/Room-/Request-/Payload-/Expected-Version-/Case-Bindung fortgesetzt werden. Kein anderer Request übernimmt Pending/Prepared; verlinkte oder gestartete Sessions werden niemals superseded/überschrieben.

## 5. Daten- und Sichtbarkeitsgrenzen

- `PublicUser`, Raumdaten und Fallzusammenfassungen sind nur raum-/kontextöffentlich, nicht anonym öffentlich.
- Actor-only Fragen, Dialoge und Hinweise werden ausschließlich in der persönlichen Response/Snapshot/Eventprojection an den berechtigten Actor gesendet.
- Raummitglieder erhalten keine fremden `memberStates`, `actionReceipts`, E-Mails, privaten Dialoge oder rohen `events[]`. Versionssprünge verraten keine privaten Inhalte und werden per Snapshot repariert.
- Fallwahrheit, Täter, Lösung, `CaseTruth`, `SuspectSecret`, Prompts, freie Referenzantworten vor Freigabe und geheime Trigger sind server-secret. Erst nach persistiertem `completed` wird die sichere `CaseResolution` projiziert.
- Nicht verfügbare Katalogfragen werden vollständig weggelassen. `QUESTION_NOT_AVAILABLE` nennt weder Bedingung noch Referenzantwort oder Existenzdetails einer nicht sichtbaren Frage.
- Output-DTOs werden mit eigenen strikten Schemas erzeugt und validiert. Clientseitiges XSS-Verstecken oder Filtern eines vorher vollständig übertragenen Objekts ist keine Sicherheitsgrenze.
- Einladungscodes sind bewusst nicht in Receipt, Secret-Replay, Room-Snapshot/Event enthalten. Ihr Klartext erscheint ausschließlich in der ersten erfolgreichen Host-Create-/Rotate-Response, niemals in Logs/Analytics/Fehlermeldungen. `room:invitation-rotated` enthält nur Version/Eventhülle und Ablaufzeit.

## 6. Untrusted Input und optionale KI

- HTTP, Socket, DB-Dokumente, Uhren/Jobs und LLM-Ausgaben werden an Systemgrenzen als `unknown` validiert. Request-Schemas sind strikt, verwenden keine unkontrollierten `any`-Casts und ignorieren keine Sicherheitsfelder.
- Katalog-/Freitextmodus ist diskriminiert. Freitext ohne Provider führt nicht zu geratenen IDs oder erfundenen Fallbackantworten; `AI_UNAVAILABLE` verändert keine Engine.
- Spielerdialoge sind untrusted Daten, nicht Systemprompts. System-/Promptteile, erlaubte Charakterkontexte und Ergebnisschema bleiben serverseitig.
- Provider erhält minimierte freigegebene Kontexte, niemals pauschal komplette Wahrheit, andere private Hinweise, Auth-/Benutzerdaten oder Geheimnisse. Ohne Provider findet null Übertragung und null Aufruf statt.
- LLM-Ausgabe darf keinen State-Patch, `questionId`, `clueId`, Hinweis, Berechtigung, Bewertung oder Phase erzeugen. Bei Katalogaktionen ersetzt ein ungültiges Ergebnis lediglich die Darstellung durch die Referenzantwort.
- Providerfehler und Timeouts enthalten nach außen keine geheimen Prompts, Modellrohtexte oder Keys. Rate-/Kostenlimits und Timeouts gelten unabhängig vom UI.

## 7. Client- und Web-Schutzmaßnahmen

- Vue-Content wird standardmäßig escaped; `v-html` mit Spieler-/Modelltext ist verboten, sofern nicht ein neuer Security-Vertrag eine sichere Sanitization festlegt. Links aus Modell-/Nutzerdaten benötigen Protokoll-Allowlist.
- Backend setzt eine restriktive Security-Header-Baseline (CSP ohne `unsafe-eval`, `nosniff`, Referrer-Policy, Frame-Schutz); konkrete Werte werden mit Vite-/Deployment-Assets geprüft, ohne Sicherheit für Komfort abzuschalten.
- Cookies werden nur über HTTPS in Produktion gesetzt. HSTS wird dort auf Transportebene aktiviert. Keine Credentials in Frontend-Fehler-/Analytics-Events.
- CSRF-Tests umfassen fehlende/falsche Origin, cross-site Fetch Metadata sowie falschen Content-Type. CORS-Tests umfassen unbekannte Origin und Socket-Handshake.
- Secrets stehen nur in lokaler/hostseitiger Secret-Verwaltung; Repository, Browserbundle, Testfixtures und CI-Logs enthalten keine echten Credentials. Tests/CI führen keine echten LLM-Aufrufe aus.

## 8. Logging und Datenschutzgrenzen

- Logs enthalten `requestId`, Operation, öffentliche Fehlercodes, notwendige IDs und Messwerte; keine Passwörter, Cookies, Tokens, Codes, E-Mail-Klartext in Routine-Logs, vollständige Chat-/Dialog-/Promptinhalte, private Hinweise, geheime Fallwahrheit oder API-Keys.
- Provider-Nutzung kann minimierte technische Metriken und Fehlerkategorie enthalten; im Basismodus entstehen keine Provider-Logs mit Dialogdaten.
- Aufbewahrungs-/TTL-Regeln sind in `docs/DATABASE.md` definiert. Fachlicher Ablauf wird auch ohne TTL-Job durchgesetzt. Backup-Löschung und Betriebslogs benötigen vor externem Betrieb eigene Fristen.
- Klartext-Codes und Auth-Secrets werden nicht einmal in Exception-Nachrichten weitergereicht. `INTERNAL_ERROR` enthält nur `requestId`; Stacktraces bleiben in einem abgesicherten Serverlog.

## 9. Verboten

- Client entscheidet über Host-, Mitgliedschafts-, Kauf- oder Berechtigungsstatus.
- Client sendet autoritativen Spielzustand, Punkte, `answerSource`-Wahl oder Auflösung.
- LLM entscheidet über Täter, Fakten, Hinweise, Folgefragen, Bewertung oder Spielphase.
- Socket-Raum-ID, Client-Version, Cookie-Signatur allein oder erfolgreicher früherer Check ersetzt vollständige Autorisierung/CAS.
- Secret-/Fremddaten werden in Public DTOs, Broadcasts, Fehlern oder Client-Logs serialisiert.
- Ein Provider/API-Schlüssel wird für Backend-Start, Readiness oder vollständigen Katalogpfad vorausgesetzt.

## 10. Erforderliche T001-Folgeprüfungen

- Auth-/Cookie-/Origin-/Revocation-Integrationstests für REST und Socket.IO.
- Raum-/Session-Matrix für Nichtmitglied, Mitglied, Host sowie immutable Start-/Endphasen.
- Replay/Parallelität: identischer Key+Payload, identischer Key+anderer Payload, Event-/Ack-Duplikat, CAS-Verlierer und Provider-Fallback.
- Datenleck-Tests auf jeden DTO/Event/Snapshot, insbesondere actor-only Fragen/Dialoge/Hinweise, Referenzantwort vor Freigabe, Lösung vor `completed` und Errors/Logs.
- Vollständiger Katalog-E2E ohne Provider mit null Aufrufen; optionale KI ausschließlich mit Mocks und identischer Engine-Auswertung.
