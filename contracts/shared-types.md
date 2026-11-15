# Shared Contract Draft

Vor Implementierung durch Architect freigeben und anschließend als TypeScript-/Zod-Verträge abbilden.

## Identifiers
- `UserId`, `RoomId`, `CaseId`, `SessionId`, `SuspectId`, `ClueId` sind string-basierte opaque IDs.

## Public DTOs
- `PublicUser`: id, displayName
- `RoomSummary`: id, status, host, members, maxPlayers
- `CaseSummary`: id, title, description, estimatedDuration
- `GameSnapshot`: sessionId, status, phase, version, members, publicClues, publicMessages
- `ChatMessage`: id, sender, content, createdAt
- `SuspectDialogue`: id, suspectId, dialogue, createdAt

## Server-only Types
- `CaseTruth`
- `SuspectSecret`
- `PrivateClue`
- `EngineState`

Server-only Typen dürfen nicht in Client-DTOs importiert oder serialisiert werden.
