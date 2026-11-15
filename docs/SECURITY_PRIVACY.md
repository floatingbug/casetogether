# Security & Privacy Checklist

Vor externem Test oder Launch prüfen und bei Bedarf fachkundig/rechtlich bewerten lassen.

- Authentifizierung, Passwort-Hashing und Session-Handling
- Autorisierung auf jedem REST- und Socket-Use-Case
- Rate Limits und Brute-Force-Schutz
- Sichere, gehashte Einladungscodes
- CSRF-/CORS-/Cookie-Konfiguration passend zur Auth-Strategie
- Eingabevalidierung und Output-Encoding
- Schutz vor Prompt Injection und LLM-Datenabfluss
- Secrets-Management und Rotation
- Logging ohne Passwörter, Tokens, private Hinweise oder unnötige Gesprächsinhalte
- Lösch- und Aufbewahrungskonzept
- Datenschutzerklärung und Auftragsverarbeitung bei KI-Anbietern
- Altersgruppe/Zielgruppe und notwendige Schutzmaßnahmen klären
- Moderation und Umgang mit missbräuchlichen Nutzern
- Payment-Webhooks später signaturprüfen und idempotent verarbeiten
- Backup-/Restore-Verfahren testen
