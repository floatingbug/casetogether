# Deployment

Dieses Kapitel beschreibt die Bereitstellung. Maßgeblich für Regeln, Verträge und
Sicherheitsentscheidungen bleiben `AGENTS.md`, `docs/ARCHITECTURE.md`, die ADRs und `contracts/`.
Der Task T011 richtet die Bereitstellung von Frontend und Backend ein. Am 18.11.2026 wurden beide
erstmals produktiv deployt: das Frontend auf Vercel, das Backend auf dem VPS hinter nginx und PM2.
Es wurde kein kostenpflichtiger Dienst aktiviert.

## Topologie

| Baustein                       | Ort                                                                                     | Status                  |
| ------------------------------ | --------------------------------------------------------------------------------------- | ----------------------- |
| Frontend (statische Vue-3-SPA) | Vercel, `https://casetogether.vercel.app`                                               | seit 2026-11-18 deployt |
| Backend (Express + Socket.IO)  | VPS hinter nginx, PM2 als Prozessmanager, `https://api.casetogether.tasse-voll-code.de` | seit 2026-11-18 deployt |
| MongoDB                        | auf dem Backend-Host, `127.0.0.1:27017`, nur serverseitig erreichbar                    | läuft lokal             |

Das Frontend wird als Static Site ausgeliefert. Es enthält keinen Server, keine Datenbanklogik und
keine Secrets. Das Backend bleibt die Autorität für Identität, Berechtigungen, Spielzustand und
Spielregeln. Browser sprechen das Backend ausschließlich über HTTPS an; die Datenbank ist vom
Client aus nicht erreichbar.

Frontend- und API-Origin liegen auf unterschiedlichen Registrierungsdomains (`vercel.app` und
`tasse-voll-code.de`). Das ist ein Cross-Site-Setup und hat Folgen für Cookies und CORS, siehe
„Bekannte Einschränkungen“.

## Vercel-Einrichtung

1. Projekt in Vercel über Git-Import des öffentlichen Repositories `floatingbug/casetogether`
   anlegen.
2. **Root Directory** ist die Repository-Wurzel, nicht `apps/frontend`. Nur dort liegen
   `pnpm-workspace.yaml` und `pnpm-lock.yaml`; eine Unterordner-Wurzel würde den pnpm-Workspace und
   damit `@casetogether/shared` nicht auflösen.
3. Framework Preset: Vite. Die Befehle aus `vercel.json` haben Vorrang vor der automatischen
   Erkennung; `vercel.json` ist die maßgebliche Quelle für Install-, Build- und Output-Pfad.
4. Environment Variable `VITE_API_ORIGIN` für die Umgebungen **Production** und **Preview**
   setzen, Wert `https://api.casetogether.tasse-voll-code.de` (Origin ohne Pfad und ohne
   abschließenden Slash). Preview-Deployments erhalten denselben API-Origin, solange es keine
   eigene Backend-Vorschauumgebung gibt.
5. Keine weiteren Variablen im Frontend-Projekt hinterlegen. Insbesondere gehören
   `SESSION_SECRET`, `MONGODB_URI` und `OPENAI_API_KEY` ausschließlich in die Backend-Umgebung.

`VITE_*`-Variablen werden zur Build-Zeit fest in das Bundle eingebettet und sind damit öffentlich
lesbar. Sie dürfen niemals Secrets, Tokens oder Zugangsdaten enthalten. Die Authentifizierung
bleibt bei der HttpOnly-Session-Cookie aus ADR-002; das Frontend speichert keine Sitzungstokens.

Werte werden beim Build eingebettet, nicht zur Laufzeit gelesen. Eine Änderung von
`VITE_API_ORIGIN` erfordert deshalb ein neues Deployment (Redeploy), kein bloßes Neuladen der Seite.

## Build und Installation im pnpm-Monorepo

`vercel.json` legt den Ablauf fest:

- `installCommand`: `pnpm install --frozen-lockfile` – installiert den gesamten Workspace
  reproduzierbar aus dem Lockfile und bricht bei Abweichungen ab.
- `buildCommand`: `pnpm --filter @casetogether/frontend build` – baut ausschließlich das Frontend.
  Das Backend wird auf Vercel weder installiert noch gestartet.
- `outputDirectory`: `apps/frontend/dist` – das von Vite erzeugte Static-Site-Verzeichnis.
- `framework`: `vite`.

Werkzeugversionen:

- Node 22 gemäß `.nvmrc` (`22.23.5`) und `engines.node` (`>=22.0.0 <23`). `.npmrc` setzt
  `engine-strict=true`, eine unpassende Node-Version bricht Installation und Build ab.
- pnpm gemäß `packageManager` (`pnpm@12.19.0`). Vercel leitet die pnpm-Version aus diesem Feld ab;
  eine abweichende pnpm-Version kann Lockfile-Format und Filterauflösung verändern und ist zu
  vermeiden.
- `pnpm-workspace.yaml` erlaubt das Lifecycle-Skript ausschließlich für `esbuild` (`allowBuilds`).
  Ohne dieses Skript kann Vite nicht bauen.

Der Frontend-Build führt zuerst `vue-tsc --noEmit` und danach `vite build` aus. Typfehler oder ein
fehlgeschlagener Typecheck brechen das Deployment ab; Vercel veröffentlicht in diesem Fall keine
neue Version. `@casetogether/shared` wird über die Workspace-Abhängigkeit und die
`development`-Exportbedingung direkt aus den Quellen aufgelöst, ein separater Shared-Build ist für
den Vercel-Build nicht erforderlich.

## SPA-Routing

Vue Router arbeitet im History-Modus. `vercel.json` leitet deshalb alle Pfade auf `/index.html` um:

```json
"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
```

Vercel prüft zuerst das Dateisystem. Vorhandene Dateien wie `/assets/*.js` und `/assets/*.css`
werden unverändert ausgeliefert; nur unbekannte Pfade wie `/login` oder `/rooms/ABC123` erhalten
`index.html`, damit ein direkter Aufruf oder ein Reload nicht in einem 404 endet.

`cleanUrls` ist bewusst nicht gesetzt: Es würde die Dateiauflösung verändern, ohne für den
History-Modus benötigt zu werden. Header-, Redirect- und Proxy-Experimente sind ebenfalls nicht
Teil dieser Konfiguration.

## Backend auf dem VPS

| Aspekt             | Wert                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Host               | `194.195.241.51`, Ubuntu 22.04, 1 vCPU, 957 MiB RAM, 512 MiB Swap                         |
| Laufzeit           | Node.js 22.19.0 aus dem nvm-Verzeichnis des Benutzers `tom`, PM2 5.3.0                    |
| Prozess            | PM2-App `casetogether-api`, Port `3100`, gebunden an `127.0.0.1`                          |
| Reverse Proxy      | nginx `/etc/nginx/sites-available/casetogether-api` mit WebSocket-Upgrade                 |
| TLS                | Let's Encrypt via certbot für `api.casetogether.tasse-voll-code.de`, automatische Renewal |
| Datenbank          | MongoDB `127.0.0.1:27017`, Datenbank `casetogether`, ohne Auth nur lokal erreichbar       |
| Deploy-Verzeichnis | `/home/tom/projects/casetogether-api` (Eigentümer `tom`)                                  |

Die PM2-Prozessliste ist per `pm2 save` gesichert; die systemd-Unit `pm2-tom` ist aktiviert und startet sie nach einem Reboot. Die Laufzeitumgebung steckt in `/home/tom/projects/casetogether-api/ecosystem.config.cjs`
(`chmod 600`, nicht im Repository): `NODE_ENV=production`, `PORT=3100`, `HOST=127.0.0.1`,
`MONGODB_URI`, `SESSION_SECRET` (48 zufällige Bytes, base64) und
`FRONTEND_ORIGIN=https://casetogether.vercel.app`. Weitere Origins werden exakt und einzeln
ergänzt; es gibt keine Wildcards.

Auf dem Server wird nicht gebaut (1 vCPU, knapp 1 GiB RAM). Stattdessen entsteht lokal ein
selbstständiges Produktionsartefakt ohne Dev-Abhängigkeiten:

```bash
pnpm --filter @casetogether/shared build
pnpm --filter @casetogether/backend build
pnpm --filter @casetogether/backend deploy --prod /tmp/ct-backend
rsync -a --delete --exclude=ecosystem.config.cjs --chown=tom:tom \
  /tmp/ct-backend/ casetogether-vps:/home/tom/projects/casetogether-api/
ssh casetogether-vps 'su - tom -c "pm2 restart casetogether-api --update-env && pm2 save"'
```

Prüfung und Betrieb:

```bash
curl -fsS https://api.casetogether.tasse-voll-code.de/api/v1/health
curl -fsS https://api.casetogether.tasse-voll-code.de/api/v1/ready
ssh casetogether-vps 'su - tom -c "pm2 logs casetogether-api --lines 100"'
```

Ein Rollback deployt denselben Ablauf aus einem früheren Commit. Es gibt bewusst keine
automatische Artefakthistorie auf dem Server.

## SSH-Zugang

Der Server akzeptiert nur noch Key-Authentifizierung:

- `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
  `PermitRootLogin prohibit-password`, `PubkeyAuthentication yes`
  (`/etc/ssh/sshd_config.d/99-casetogether-hardening.conf`).
- Der administrative Key liegt nur auf der Admin-Maschine, niemals im Repository.
- Das Root-Passwort wurde rotiert und ist ausschließlich root-lesbar auf dem Server
  hinterlegt; der Wert gehört in einen Passwortmanager. Passwort-Login ist deaktiviert.
- Notfallzugang: IONOS-Konsole. Vor jeder SSH-Konfigurationsänderung wird ein Backup der
  `sshd_config` unter `/root/` angelegt und `sshd -t` geprüft.

## Backup, Restore und Healthcheck

- Täglich um 03:15 Uhr erstellt `/usr/local/bin/casetogether-backup.sh` per `mongodump` ein
  gzip-Archiv unter `/var/backups/casetogether` (Eigentümer `root`, Modus `600`, Aufbewahrung
  sieben Tage). Mitgesichert wird `ecosystem.config.cjs`, weil darin `SESSION_SECRET` liegt.
  Steuerung: `/etc/cron.d/casetogether-backup`.
- Manuelles Backup und Restore:

  ```bash
  ssh casetogether-vps /usr/local/bin/casetogether-backup.sh
  ssh casetogether-vps 'ls -lh /var/backups/casetogether'

  # Restore zunächst immer in eine Wegwerf-Datenbank prüfen:
  ssh casetogether-vps 'mongorestore --uri="mongodb://127.0.0.1:27017" \
    --archive=/var/backups/casetogether/<datei>.archive --gzip \
    --nsFrom="casetogether.*" --nsTo="casetogether_restore_test.*"'
  ```

  Der Restore in die produktive Datenbank erfolgt erst nach Prüfung mit `--drop` und
  anschließendem Neustart von `casetogether-api`.

- `/usr/local/bin/casetogether-healthcheck.sh` prüft alle fünf Minuten
  `https://api.casetogether.tasse-voll-code.de/api/v1/ready`. Es protokolliert und meldet nur
  Zustandswechsel (gesund → Fehler bzw. Fehler → gesund) mit Status, verfügbarem RAM und
  Diskbelegung in `/var/log/casetogether-health.log`; die Datei wird ab 512 KiB gekürzt.
  Schwellen: Status ungleich 200, weniger als 80 MiB RAM, mehr als 85 % Disk.
  Steuerung: `/etc/cron.d/casetogether-healthcheck`.
- Optionaler Webhook: Liegt in `/etc/casetogether/alert-webhook` (Modus `600`, root) eine URL,
  sendet der Healthcheck bei Zustandswechseln JSON `{"text": "..."}` dorthin. Das passt zu
  Slack-/Discord-/ntfy-kompatiblen Webhooks, ohne weitere Software auf dem Server.
- **Externes Alerting:** Empfohlen ist zusätzlich ein Uptime-Monitor bei einem externen Dienst
  (gängig und kostenlos: UptimeRobot). Monitor auf `https://api.casetogether.tasse-voll-code.de/
api/v1/ready` mit HTTP(s)-Prüfung, 5-Minuten-Intervall und E-Mail-Alarm. Der Monitor erkennt
  auch einen Ausfall des gesamten Hosts, den der lokale Healthcheck nicht melden kann. Die
  Einrichtung erfordert ein Konto beim Anbieter; mit einem API-Schlüssel kann der Monitor
  automatisiert angelegt werden.

## Automatische Deployments und Rollback

- Push auf einen Branch oder Öffnen/Aktualisieren eines Pull Requests erzeugt ein
  **Preview Deployment** mit eigener URL.
- Merge beziehungsweise Push auf `main` erzeugt ein **Production Deployment** auf
  `https://casetogether.vercel.app`.
- CI (`.github/workflows/ci.yml`) bleibt davon getrennt und führt weiterhin Lint, Typecheck, Tests,
  Vertragsprüfung, Formatprüfung und Build aus. Vercel-Deployments ersetzen die CI-Gates nicht.
- Rollback erfolgt über die Vercel-Deployment-Liste: ein früheres Production Deployment als
  aktuelles Promotion-Ziel auswählen. Ein Rollback über Vercel ist ein Deployment-Schritt und
  benötigt wie jeder Produktivvorgang eine ausdrückliche Freigabe.

## Lokale Prüfung der Build-Kette

Die gleiche Kette wie auf Vercel lässt sich lokal nachvollziehen:

```bash
pnpm install --frozen-lockfile
pnpm --filter @casetogether/frontend build
pnpm --filter @casetogether/frontend preview
```

`vite preview` liefert das gebaute Verzeichnis unter `http://127.0.0.1:5173` aus. Der
Vite-Entwicklungsserver proxyt `/api` und `/socket.io` nach `http://127.0.0.1:3000`; `preview`
tut das nicht.

Ein leerer oder nicht gesetzter `VITE_API_ORIGIN` bedeutet relatives Verhalten: Das Frontend
spricht `/api/v1` und Socket.IO relativ zum ausliefernden Origin an. Das funktioniert lokal hinter
dem Dev-Proxy und ist die Voreinstellung für lokale Entwicklung. Für die Vercel-Bereitstellung ist
der absolute API-Origin zu setzen, weil der Vercel-Origin kein Backend ausliefert (siehe unten).

## Stand der Bereitstellung (2026-11-18)

- GitHub: öffentliches Repository `floatingbug/casetogether`. CI läuft bei Pull Requests und auf
  `main` (Lint, Typecheck, 86 Shared-, 347 Backend- und 147 Frontend-Tests, 5 Playwright-Smokes,
  Vertragsprüfung, Format und Build).
- Vercel: Projekt mit dem Repository verbunden; Production-Deployments von `main` sind `READY`,
  Alias `https://casetogether.vercel.app`, Preview-Deployments je Branch/PR.
- Statische Auslieferung geprüft: `/` und `/login` liefern HTTP 200 mit identischem
  `index.html` (SPA-Fallback), `/assets/index-*.js` und `.css` liefern HTTP 200 mit korrektem
  `Content-Type`.
- `VITE_API_ORIGIN` ist im Production-Bundle enthalten; der Browser ruft
  `https://api.casetogether.tasse-voll-code.de/api/v1/me` auf.
- Backend: `https://api.casetogether.tasse-voll-code.de` liefert für `/api/v1/health` und
  `/api/v1/ready` HTTP 200 (`mongodb: up`); TLS-Zertifikat von Let's Encrypt.
- Auth live geprüft: Registrierung über die Production-Oberfläche (201), Session-Cookie mit
  `HttpOnly; Secure; SameSite=None`, `/api/v1/me` mit Cookie 200, CORS-Preflight 204 mit exakter
  Origin; fehlende/fremde Origins bleiben 403 `CSRF_REJECTED`.
- Socket.IO live geprüft: Raum über die Oberfläche erstellt, Mitglied als „online“ projiziert,
  Chatnachricht über `wss://api.casetogether.tasse-voll-code.de/socket.io` zugestellt.
- Testkonten und Testraum wurden nach der Verifikation entfernt; die Datenbank enthält nur den
  beim Start provisionierten Fall.
- Offen: Einrichtung des externen Uptime-Monitors (Konto beim Anbieter erforderlich) und die restlichen T011-Akzeptanzkriterien (u. a. Staging, Aufbewahrungsnachweise).

## Bekannte Einschränkungen

- **`/api` auf dem Vercel-Origin ist kein Proxy.** Die SPA-Rewrite-Regel liefert für jeden Pfad
  `index.html`, auch für `/api/v1/...`. Das Frontend muss deshalb mit gesetztem
  `VITE_API_ORIGIN` arbeiten; ohne den Wert treffen API-Aufrufe die Vercel-Auslieferung und nicht
  das Backend.
- **Cross-Site-Cookies.** Für `casetogether.vercel.app` → `api.casetogether.tasse-voll-code.de`
  setzt Produktion `SameSite=None; Secure` (ADR-004); Entwicklung und Test bleiben bei
  `SameSite=Lax` ohne `Secure`. Das Backend muss `https://casetogether.vercel.app` als exakte
  CORS-Origin zulassen (`FRONTEND_ORIGIN`, keine Wildcards). Jede Preview-Origin müsste separat
  ergänzt werden.
- **Preview-Origins.** Jedes Preview Deployment hat eine eigene URL. Sollen Preview-Builds
  authentifizierte Aufrufe ausführen, müssen diese Origins zusätzlich exakt in der
  Backend-Konfiguration eingetragen werden. Ein pauschales `*` ist unzulässig.
- **Safari und iOS** blockieren zunehmend Third-Party-Cookies zwischen unterschiedlichen
  Registrierungsdomains. Für einen stabilen Betrieb ist eine Frontend-Subdomain unter derselben
  Registrierungsdomain (beispielsweise `app.casetogether.tasse-voll-code.de`) die robustere
  Lösung; dann genügt wieder ein Same-Site-Cookie. Das ist eine spätere Infrastrukturentscheidung
  und nicht Teil dieses Tasks.
- **Ungültiger `VITE_API_ORIGIN`.** Ein Wert mit Pfad, Query, Credentials oder ein `http:`-Origin
  außerhalb von `localhost`/`127.0.0.1` bricht den App-Start im Browser. Der Vite-Build selbst
  bleibt erfolgreich, weil App-Module beim Build nicht ausgeführt werden; der Fehler zeigt sich
  deshalb erst beim Laden der Seite.
- **Öffentliche Werte.** `VITE_API_ORIGIN` ist kein Secret und steht im Browser-Bundle. Deshalb
  enthält das Frontend-Bundle keine Tokens und keine Schlüssel; die Sitzung bleibt ausschließlich
  im HttpOnly-Cookie.

## Verifikations-Checkliste

Nach einem Deployment von `main` auf `https://casetogether.vercel.app`:

- [ ] Startseite lädt die SPA, die Konsole zeigt keine Ladefehler der Bundles.
- [ ] Deep-Link `/login` direkt aufrufen und die Seite neu laden: die Login-Ansicht erscheint,
      kein 404 und kein Vercel-Fehlerbild.
- [ ] Mindestens ein Asset unter `/assets/` liefert HTTP 200 mit passendem `Content-Type`.
- [ ] Client-seitige Navigation (beispielsweise zu `/register`) funktioniert ohne vollständigen
      Reload; ein unbekannter Pfad zeigt die NotFound-Ansicht.
- [ ] Bis zum Backend-Deployment sind Netzwerk-/CORS-Fehler bei Login- und API-Aufrufen erwartet;
      sie sind kein Fehler der Static-Site-Auslieferung.
- [ ] Nach dem Backend-Deployment: Login setzt ein Session-Cookie mit `SameSite=None; Secure`, die
      Antwort trägt die exakte CORS-Origin, und ein Reload hält die Sitzung.
