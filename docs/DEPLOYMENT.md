# Deployment

Dieses Kapitel beschreibt die geplante Bereitstellung. Maßgeblich für Regeln, Verträge und
Sicherheitsentscheidungen bleiben `AGENTS.md`, `docs/ARCHITECTURE.md`, die ADRs und `contracts/`.
Der Task T011 richtet ausschließlich die Vercel-Konfiguration des Frontends und diese Dokumentation
ein. Es wurde kein produktives Deployment ausgeführt und kein kostenpflichtiger Dienst aktiviert.

## Topologie

| Baustein                       | Ort                                                                                     | Status                     |
| ------------------------------ | --------------------------------------------------------------------------------------- | -------------------------- |
| Frontend (statische Vue-3-SPA) | Vercel, `https://casetogether.vercel.app`                                               | in diesem Task vorbereitet |
| Backend (Express + Socket.IO)  | VPS hinter nginx, PM2 als Prozessmanager, `https://api.casetogether.tasse-voll-code.de` | noch nicht deployt         |
| MongoDB                        | auf dem Backend-Host, nur serverseitig erreichbar                                       | noch nicht deployt         |

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

## Bekannte Einschränkungen

- **Backend noch nicht erreichbar.** Solange der VPS nicht deployt ist, schlagen Login,
  Registrierung, Raum- und Spielaktionen fehl. Startseite, Routing, Deep-Links und Assets sind
  dennoch prüfbar.
- **`/api` auf dem Vercel-Origin ist kein Proxy.** Die SPA-Rewrite-Regel liefert für jeden Pfad
  `index.html`, auch für `/api/v1/...`. Das Frontend muss deshalb mit gesetztem
  `VITE_API_ORIGIN` arbeiten; ohne den Wert treffen API-Aufrufe die Vercel-Auslieferung und nicht
  das Backend.
- **Cross-Site-Cookies.** Für `casetogether.vercel.app` → `api.casetogether.tasse-voll-code.de`
  verlangt der Browser ein Session-Cookie mit `SameSite=None; Secure`. Das Backend muss zudem
  `https://casetogether.vercel.app` als exakte CORS-Origin zulassen (`FRONTEND_ORIGIN`, keine
  Wildcards). Die ADR-002-Basis sieht `SameSite=Lax` vor; die Anpassung ist Backend-Eigentum und
  wird dort beim Backend-Deployment geprüft, nicht in diesem Task geändert.
- **Preview-Origins.** Jedes Preview Deployment hat eine eigene URL. Sollen Preview-Builds
  authentifizierte Aufrufe ausführen, müssen diese Origins zusätzlich exakt in der
  Backend-Konfiguration eingetragen werden. Ein pauschales `*` ist unzulässig.
- **Safari und iOS** blockieren zunehmend Third-Party-Cookies zwischen unterschiedlichen
  Registrierungsdomains. Für einen stabilen Betrieb ist eine Frontend-Subdomain unter derselben
  Registrierungsdomain (beispielsweise `app.casetogether.tasse-voll-code.de`) die robustere
  Lösung; dann genügt wieder ein Same-Site-Cookie. Das ist eine spätere Infrastrukturentscheidung
  und nicht Teil dieses Tasks.
- **Auswertung von `VITE_API_ORIGIN`.** Die Variable wird im Frontend-Client ausgewertet. Solange
  diese Auswertung nicht integriert ist, verwendet das Frontend relative Pfade und erreicht auf
  Vercel kein Backend.
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
