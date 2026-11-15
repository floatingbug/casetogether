---
name: Backend Development
description: Für Express-APIs, Authentifizierung, Application Use Cases, Repositories und Backend-Validierung im CaseTogether-Monolithen verwenden.
---

# Skill: Backend Development

## Ziel
Robuste, typisierte Express-API nach modularer Monolith-Architektur erstellen.

## Vorgehen
1. Use Case und API-Vertrag lesen.
2. Eingabe-/Ausgabeschemas in Shared oder Backend-Schema definieren.
3. Authentifizierung und Autorisierung festlegen.
4. Service/Use Case implementieren.
5. Repository-Abstraktion und MongoDB-Implementierung ergänzen.
6. Dünnen Controller und Router ergänzen.
7. Unit- und Integrationstests schreiben.
8. OpenAPI aktualisieren.

## Konventionen
- HTTP-Statuscodes konsistent verwenden.
- Fehler als typisierte Domain-/Application-Fehler modellieren.
- Kein direkter Datenbankzugriff im Controller.
- Pagination/Filter nur implementieren, wenn spezifiziert.
- IDs und Objekt-IDs an Systemgrenzen validieren.
- Transaktionen nur dort einsetzen, wo Datenkonsistenz es verlangt.
