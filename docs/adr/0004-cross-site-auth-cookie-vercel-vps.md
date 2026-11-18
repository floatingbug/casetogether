# ADR-004: Cross-Site-Auth-Cookie für getrennte Vercel- und VPS-Hosts

- Status: Accepted
- Datum: 2026-11-18
- Verantwortlich: Architect

## Kontext

Das Frontend wird als statische SPA auf Vercel ausgeliefert
(`https://casetogether.vercel.app`), das Backend läuft auf einem VPS hinter nginx
(`https://api.casetogether.tasse-voll-code.de`). `vercel.app` steht auf der Public Suffix List;
beide Origins gehören damit zu unterschiedlichen Sites.

ADR-002 legt für `ct_session` `SameSite=Lax` fest. Browser senden Lax-Cookies bei cross-site
`fetch`/XHR- und WebSocket-Requests jedoch nicht mit. Authentifizierung über REST und Socket.IO
würde in dieser Topologie brechen. Eine Frontend-Subdomain unter derselben Registrierungsdomain
wurde für den aktuellen Schritt bewusst nicht eingerichtet.

## Entscheidung

1. In Produktion erhält `ct_session` `SameSite=None` und weiterhin `Secure`, `HttpOnly` und
   `Path=/`. `Development` und `Test` bleiben bei `SameSite=Lax` ohne `Secure`, damit lokale
   HTTP-Entwicklung funktioniert. Ein `Domain`-Attribut wird nicht gesetzt.
2. Die bestehenden Schutzgrenzen bleiben unverändert: exakte CORS-Allowlist mit Credentials,
   Origin-Prüfung für jede unsichere Methode, JSON-Pflicht und serverseitige Session-/
   Berechtigungsprüfung. `SameSite=None` ersetzt diese Prüfungen nicht. `Sec-Fetch-Site:
cross-site` ist in dieser Topologie erwartbar; maßgeblich ist ausschließlich, ob der
   übermittelte `Origin` exakt in der Allowlist steht. Fehlende oder fremde Origins bleiben
   abgelehnt.
3. Das Backend bindet ausschließlich an `127.0.0.1` (optional per `HOST` überschreibbar). nginx
   terminiert TLS und setzt `X-Forwarded-For`/`X-Forwarded-Proto`. Express vertraut nur
   Loopback-Proxies (`trust proxy: 'loopback'`), damit IP-Rate-Limits echte Client-IPs sehen und
   öffentliche Clients `X-Forwarded-For` nicht spoofen können.
4. Preview-Deployments erhalten keine pauschale Freigabe. Sollen sie authentifizierte Aufrufe
   ausführen, müssen ihre Origins exakt in `FRONTEND_ORIGIN` ergänzt werden.

## Alternativen

- **Frontend-Subdomain derselben Registrierungsdomain** (z. B.
  `casetogether.tasse-voll-code.de`): Dann genügt `SameSite=Lax`. Für den aktuellen Schritt vom
  Nutzer abgelehnt; bleibt der empfohlene Rückweg für breite Browser-Kompatibilität.
- **Vercel-Rewrite als API-Proxy:** WebSocket-Verbindungen lassen sich darüber nicht zuverlässig
  proxien; verworfen.
- **Token im Browser-Storage:** Bereits in ADR-002 aus Sicherheitsgründen verworfen.

## Konsequenzen

- Safari/iOS blockieren Third-Party-Cookies (ITP). Login kann dort fehlschlagen. Für breite
  Kompatibilität ist die Subdomain-Variante nötig; dann kann wieder `SameSite=Lax` gelten.
- `SameSite=None` vergrößert die CSRF-Fläche. Kompensiert durch exakte Origin-Prüfung,
  CORS-Allowlist, JSON-Pflicht, `HttpOnly` und serverseitige Session-Revocation.
- Das Cookie wird nur über HTTPS gesetzt; gültiges TLS auf dem API-Host ist Voraussetzung.
- Tests decken `SameSite`/`Secure` je Umgebung und den Loopback-Trust ab.

## Umsetzung

`apps/backend/src/config.ts`, `apps/backend/src/main.ts`, `apps/backend/src/app.ts` und die
zugehörigen Backend-Tests; ergänzend `docs/DEPLOYMENT.md`, `specs/security-boundaries.md` und der
Statusvermerk in ADR-002.
