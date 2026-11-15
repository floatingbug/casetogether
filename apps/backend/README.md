# Backend-Gerüst (T002)

Enthält ausschließlich Express-/Security-Grundkonfiguration und die System-Endpunkte
`GET /api/v1/health` und `GET /api/v1/ready`.

Ohne T003-Datenbankadapter ist Readiness absichtlich `503 not_ready` mit
`checks.mongodb = down`. Liveness benötigt weder MongoDB noch einen KI-Provider.
Das Gerüst enthält keine Auth-, Raum-, Socket-, Game- oder AI-Implementierung.
