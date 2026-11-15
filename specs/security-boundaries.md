# Spec: Security Boundaries

## Autoritative Quellen
- Auth-Service: Identität
- Room-Service: Mitgliedschaft/Rollen
- Game Engine: Spielzustand und Fakten
- Entitlement-Service (später): Kaufrechte
- LLM: nur Vorschläge/Dialogtext

## Verboten
- Client entscheidet über Host-Rechte.
- Client sendet autoritativen Spielzustand.
- LLM entscheidet über Täter, Hinweise oder Spielphase.
- Socket-Raum-ID ersetzt Autorisierungsprüfung.
- Client bestimmt Kaufstatus.
- Private/server-secret Daten werden in öffentliche DTOs serialisiert.
