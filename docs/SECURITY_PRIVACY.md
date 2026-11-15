# Security & Privacy – MVP-Konzept und Vor-Launch-Checkliste

Technische Sicherheits- und Sichtbarkeitsgrenzen sind in `specs/security-boundaries.md` verbindlich spezifiziert. Dieses Dokument ergänzt Dateninventar, Aufbewahrung und Prüfpunkte. Es ist keine Rechtsberatung und keine Freigabe für externe Tester oder einen öffentlichen Launch.

## Technische MVP-Basis

- Revozierbare HttpOnly-Cookie-Sessions; Argon2id-Passwort-Hashes; Origin-/Fetch-Metadata-/CORS-/CSRF-Schutz für REST und Socket.IO.
- Autorisierung pro Use Case, 60-Bit-Einladungscodes nur gehasht, serverseitige Rate Limits und maximale Payloadgrößen.
- Strikte DTO-/Event-Projektion für raumöffentliche, player-private und server-secret Daten; keine geheimen Fallregeln in der Übertragung.
- Eingabevalidierung und Vue-Output-Encoding; kein ungeprüftes `v-html` für Spieler-/Modelltext.
- Optionaler KI-Adapter nur serverseitig mit minimiertem Kontext, strukturierter Validierung, Timeout und Limits; der Katalog-Basismodus überträgt keine Dialogdaten an Provider und ruft keinen auf.
- Keine Secrets im Frontend-Bundle, Repository, lokalen Testfixtures oder CI. Keine echten LLM-Aufrufe in Tests/CI.
- Strukturierte technische Logs ohne Passwörter, Tokens, Codes, geheime Lösungen, private Hinweise oder vollständige private Chat-/Dialog-/Promptinhalte.

## Dateninventar und Verarbeitungszwecke

| Daten | Zweck | Klassifikation | Technische Basis |
|---|---|---|---|
| Normalisierte E-Mail, Passwort-Hash, Anzeigename | Konto/Login und Anzeige | player-private/server-secret | `users`; kein Raum-DTO für E-Mail/Hash |
| Auth-Session-Hash, Ablauf/Revocation | Login aufrechterhalten, Logout | server-secret | `authSessions`, 7 Tage plus TTL-Cleanup |
| Raummitgliedschaft, Hostrolle, Präsenz | privates kooperatives Spiel | raum-privat/flüchtig | `rooms`, Präsenz nur im Prozess |
| Gehashter Einladungscode | Raumbeitritt | server-secret; Klartext mitglieder-privat | 60 min, Rotation, nie logs |
| Öffentliche/private Fragen, Dialoge, Hinweise, Ergebnis | Spielablauf und Synchronisation | raum- bzw. actor-privat/server-secret | fixierte Session, empfängerspezifische DTOs |
| Chat | Gruppenkommunikation | raum-privat | `messages`, Snapshot max. 50 |
| Request-/Fehler-IDs, Aggregate, Limits | Betrieb und Missbrauchsschutz | technisch privat | minimierte, zugriffsgeschützte Logs |
| Optional minimierter Charakter-/Fragekontext | optionale Dialogformulierung | nur ausdrücklich freigegeben | nur bei aktiviertem Provider; kein Basismodus |

## Aufbewahrung und Löschung

Die technischen Defaults stehen normativ in `docs/DATABASE.md`: Auth-Sessions sieben Tage, Einladungen 60 Minuten, ungestartete Lobbys 24 Stunden, abgeschlossene/abandoned Spielstände 30 Tage. Fachlicher Ablauf gilt unabhängig vom asynchronen TTL-Löschlauf. Präsenz wird nicht persistent gespeichert. Provider-Rohprompts/-responses werden nicht als Betriebslog gespeichert.

Vor externem Test/Launch müssen rechtliche und betriebliche Anforderungen gemeinsam bewertet werden:

- Selbstbedienungs- oder Support-Löschung für Konten und verbleibende identifizierbare Daten; Nutzerkonten haben derzeit keinen pauschalen TTL-Prozess.
- Konkrete Laufzeit und Löschung von Backups sowie dokumentierte Wiederherstellung, ohne TTL-Löschung fälschlich als Backup-Löschung darzustellen.
- Logaufbewahrung, Missbrauchs-/Sicherheitsprotokolle, Löschkonzept und Zugriffsrechte.
- Datenminimierung und ob kuratierte Session-/Chatdaten kürzer aufbewahrt werden können.
- Timestamp-Verhalten und Löschstatus nach Restore aus Backups.

## Optionale KI-Anbieter – Vor Aktivierung mit realen Daten

- Rechtsgrundlage, Datenschutzerklärung, Informationspflichten und gegebenenfalls Einwilligungs-/Gruppeninformation klären.
- Auftragsverarbeitung, Regionen/Übermittlungen, Provider-Trainings-/Retention-Einstellungen und Unterauftragsverarbeiter prüfen.
- Datenkategorien und tatsächlich übertragene Promptfelder dokumentieren; niemals komplette Wahrheit, fremde private Daten oder Auth-/Kontodaten übertragen.
- Kostenlimits, Timeout, Fallback und Verhalten ohne Provider testen. Kein providerbezogener Readiness-Zwang.
- Keine produktive Aktivierung oder kostenpflichtige Live-Aufrufe ohne ausdrückliche aktuelle Nutzerfreigabe.

## Vor externem Test oder Launch fachkundig/rechtlich prüfen

- Ziel-/Altersgruppe, erforderliche Schutzmaßnahmen und frei eingebbare Inhalte
- Datenschutzinformationen, Lösch-/Auskunftsprozesse und Aufbewahrungsfristen
- Moderation, Meldung und Umgang mit missbräuchlichen Inhalten/Nutzern in Chat/Freitext
- Verantwortlichkeiten, Hosting-Regionen, Auftragsverarbeitungen und internationale Übermittlungen
- Cookie-/Session-Darstellung und notwendige Hinweise
- Notfallprozess für Datenlecks, Secret-Rotation, Wiederherstellung und Nutzerinformation

Diese rechtlichen/Altersfreigabe-/Moderationspunkte sind bewusst keine still getroffenen Entscheidungen in T001. Sie blockieren nicht die lokale vertragsbasierte Implementierung, aber externe Tester/öffentlichen Betrieb dürfen nicht allein aufgrund technischer Gates freigegeben werden.

## Vor Produktivbetrieb technisch nachweisen

- Auth-, Cookie-, Origin-, Revocation-, Raum-, Rollen- und Datenleck-Matrix bestanden.
- Idempotente Replays, Streaming-/Netzwerkabbrüche und CAS-Parallelität getestet.
- Vollständiger Katalog-E2E ohne Provider/API-Schlüssel und mit null nachgewiesenen Provideraufrufen bestanden.
- Optionale KI nur mit Mocks getestet; Injections, Timeouts, fehlerhafte Ausgaben und Budgets geprüft.
- Keine Secrets/Debug-Artefakte in Builds/Logs; CSP/CORS/Cookie/HTTPS/HSTS geprüft.
- Backup/Restore, verwaiste Start-Session-Bereinigung aus ADR-003, TTL-/Cleanup-Verhalten und Kontolöschprozess getestet.
- Fehlerüberwachung datensparsam betrieben; Security-Header und Dependency-Scanning konfiguriert.
- Payment-Webhooks erst nach später separatem Vertrag signaturgeprüft und idempotent verarbeitet; kein Payment im MVP.
