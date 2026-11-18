# ADR-002: Revozierbare Auth-Sessions in HttpOnly-Cookies

- Status: Accepted (T001-Freeze, Nutzerfreigabe 2026-11-15); `SameSite` in Produktion durch
  ADR-004 präzisiert
- Datum: 2026-11-15
- Verantwortlich: Architect

## Kontext

Die Vue-SPA benötigt eine gemeinsame Authentifizierung für REST und Socket.IO. Ein langfristig im Browser-Speicher abgelegter Bearer-Token würde bei XSS besonders leicht exfiltrierbar sein. Gleichzeitig muss Logout eine Session serverseitig widerrufen können. Cookie-Authentifizierung benötigt dafür expliziten CSRF-, CORS- und Origin-Schutz.

## Entscheidung

1. Der Server verwendet eine persistierte, revozierbare Auth-Session mit mindestens 256 Bit kryptografisch zufälliger, opaker Session-ID. Der Cookie-Wert besteht aus Session-ID und HMAC-SHA-256-Signatur mit einem zweckgebunden abgeleiteten Schlüssel aus `SESSION_SECRET`.
2. MongoDB speichert ausschließlich einen Hash der Session-ID, `userId`, `createdAt`, `expiresAt` und technische Revocationsdaten. Weder Session-ID noch Cookie-Signatur werden geloggt oder an andere Clients übertragen.
3. Das Cookie heißt `ct_session`, ist `HttpOnly`, `Path=/` und in Produktion `Secure`. In
   Entwicklung und Test gilt `SameSite=Lax`. Für die getrennten Vercel-/VPS-Origins verlangt
   Produktion `SameSite=None`, siehe ADR-004. Die maximale Lebensdauer beträgt sieben Tage und
   entspricht der serverseitigen `expiresAt`; ein Cookie allein verlängert die Session nicht.
   Logout löscht bzw. revoziert den Serverdatensatz und setzt das Cookie mit identischen
   Pfad-/Sicherheitsattributen zurück.
4. Browser-JavaScript speichert kein Bearer-Token in Local-/Session-Storage. Das Auth-Cookie wird automatisch bei zugelassenem REST-/Socket-Transport mitgesendet und ist niemals Teil von URL, Request-Body oder Client-DTO.
5. Jede unsichere REST-Methode verlangt ein JSON-Body-Format, soweit ein Body vorgesehen ist, sowie einen exakt gegen `FRONTEND_ORIGIN` beziehungsweise die Server-Allowlist geprüften `Origin`. Abweichende/fehlende Origins oder cross-site `Sec-Fetch-Site` werden mit `CSRF_REJECTED` abgelehnt. Diese Prüfung ergänzt, nicht ersetzt SameSite und Autorisierung.
6. CORS erlaubt nur konfigurierte Origins, `credentials: true`, benötigte Methoden und `Content-Type`; Wildcards mit Credentials sind verboten. Der Socket.IO-Handshake prüft denselben Origin-Allowlist-Eintrag, das Auth-Cookie und die serverseitige Session. Query-/Body-Tokens sind verboten.
7. REST prüft Auth-Session und fachliche Berechtigung pro Use Case. Socket.IO prüft Auth beim Handshake und Raummitgliedschaft bei jedem Event. Eine serverseitig revozierte Session ist für neue Aktionen ungültig; Logout trennt zugehörige Sockets serverseitig.
8. `SESSION_SECRET` ist mindestens 32 Byte zufälliges Server-Secret und nur für Basismodus-Auth erforderlich, nicht für einen KI-Provider. Rotation wird als Betriebsverfahren dokumentiert; sie darf bestehende Sessions kontrolliert invalidieren.

## Alternativen

- **JWT im Local Storage:** Verworfen wegen Token-Exfiltration durch XSS und fehlender unmittelbarer Revocation.
- **Zustandsloser JWT im Cookie:** Verworfen, weil Logout und Revocation sonst zusätzliche Denylists oder sehr kurze Tokenlaufzeiten samt Refresh-Mechanismus erfordern.
- **Nur SameSite ohne Origin-Prüfung:** Verworfen, da SameSite allein keine ausreichende, explizit prüfbare Schutzgrenze für alle Browser-/Subdomain-Fälle darstellt.
- **Separates Doppel-Cookie-CSRF-Token:** Für den MVP nicht erforderlich, weil SameSite=Lax, strikte Origin-/Fetch-Metadata-Prüfung, JSON und CORS zusammen eine kleinere serverseitig kontrollierte Grenze ergeben. Bei geändertem Deployment wird die Entscheidung erneut bewertet.

## Konsequenzen

- REST und WebSocket/Long-Polling müssen Credentials und Origin-Prüfung korrekt konfigurieren.
- Auth-Sessions erzeugen einen MongoDB-Lesezugriff und einen TTL-indexierten Speicherdatensatz; dafür sind Logout und Ablauf serverseitig durchsetzbar.
- Tests müssen fehlende/ungültige Cookies, abgelaufene/revozierte Sessions, abweichende Origins und Socket-Reconnect abdecken.
- XSS bleibt ein Sicherheitsrisiko; HttpOnly schützt das Cookie vor direktem Auslesen, ersetzt aber keine Output-Encoding-/CSP-Maßnahmen.

## Umsetzung

Betroffen sind T002 (Cookie/CORS-Grundkonfiguration), T003 (Passwort- und Auth-Session-Persistenz), T004 (Credential-fähiger API-/Socket-Client), T006 (Socket-Handshake und Revocation) sowie `contracts/openapi.yaml`, `contracts/events.md`, `docs/DATABASE.md` und `specs/security-boundaries.md`.
