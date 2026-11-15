# `@casetogether/shared`

Framework-neutrale, strikte TypeScript-/Zod-Abbildung der freigegebenen Verträge in
`contracts/shared-types.md` und `contracts/events.md`.

Die Paketwurzel exportiert ausschließlich Client-DTOs, IDs, Requests, Responses,
Ack- und Event-Schemas. Serverseitige Persistenz-, Provider-, Prompt- oder geheime
Falltypen gehören ausdrücklich nicht in dieses Paket.

- `@casetogether/shared` mit Bedingung `development`: TypeScript-Quellen für lokale Tools
- Standard-Export nach `pnpm --filter @casetogether/shared build`: kompilierte ESM-Ausgabe
- `IsoDateTimeSchema`: validiert RFC-3339-Eingaben inklusive Offset
- `ServerIsoDateTimeSchema`: validiert Serverausgaben ausschließlich als UTC `Z` mit Millisekunden
