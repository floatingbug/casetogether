import { z } from 'zod';
import {
  CatalogQuestionSchema,
  ClueSchema,
  PublicSuspectSchema,
  SuspectDialogueSchema,
} from './cases.js';
import {
  CaseIdSchema,
  CaseVersionSchema,
  NonNegativeIntegerSchema,
  RoomIdSchema,
  ServerIsoDateTimeSchema,
  SessionIdSchema,
  SuspectIdSchema,
  VersionSchema,
} from './primitives.js';
import { PublicUserSchema, RoomMemberSchema } from './rooms.js';
import { isChronologicallySorted, rejectDuplicateIds } from './validation.js';

const normalizedText = (maximumLength: number) =>
  z.string().trim().normalize('NFC').min(1).max(maximumLength);

export const GamePhaseSchema = z.enum(['investigating', 'completed', 'abandoned']);
export const FinalVerdictSchema = z.enum(['correct', 'incorrect']);

export const FinalSubmissionSchema = z
  .object({
    suspectId: SuspectIdSchema,
    submittedBy: PublicUserSchema,
    submittedAt: ServerIsoDateTimeSchema,
  })
  .strict();

export const CaseResolutionSchema = z
  .object({
    suspectId: SuspectIdSchema,
    title: normalizedText(200),
    explanation: normalizedText(8000),
  })
  .strict();

export const GameResultSchema = z
  .object({
    verdict: FinalVerdictSchema,
    awardedPoints: NonNegativeIntegerSchema,
    maximumPoints: NonNegativeIntegerSchema,
    feedback: normalizedText(2000),
    resolution: CaseResolutionSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.awardedPoints > result.maximumPoints) {
      context.addIssue({
        code: 'custom',
        path: ['awardedPoints'],
        message: 'Awarded points cannot exceed maximum points',
      });
    }
  });

export const GameSnapshotSchema = z
  .object({
    sessionId: SessionIdSchema,
    roomId: RoomIdSchema,
    caseId: CaseIdSchema,
    caseVersion: CaseVersionSchema,
    phase: GamePhaseSchema,
    version: VersionSchema,
    members: z.array(RoomMemberSchema).min(2).max(4),
    suspects: z.array(PublicSuspectSchema).length(3),
    availableQuestions: z.array(CatalogQuestionSchema).max(500),
    publicClues: z.array(ClueSchema).max(500),
    privateClues: z.array(ClueSchema).max(500),
    dialogues: z.array(SuspectDialogueSchema).max(2000),
    finalSubmission: FinalSubmissionSchema.nullable(),
    result: GameResultSchema.nullable(),
    startedAt: ServerIsoDateTimeSchema,
    finishedAt: ServerIsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    rejectDuplicateIds(snapshot.members, (member) => member.user.id, ['members'], context);
    rejectDuplicateIds(snapshot.suspects, (suspect) => suspect.id, ['suspects'], context);
    rejectDuplicateIds(
      snapshot.availableQuestions,
      (question) => question.questionId,
      ['availableQuestions'],
      context,
    );
    rejectDuplicateIds(snapshot.publicClues, (clue) => clue.id, ['publicClues'], context);
    rejectDuplicateIds(snapshot.privateClues, (clue) => clue.id, ['privateClues'], context);
    rejectDuplicateIds(snapshot.dialogues, (dialogue) => dialogue.id, ['dialogues'], context);

    if (!isChronologicallySorted(snapshot.dialogues)) {
      context.addIssue({
        code: 'custom',
        path: ['dialogues'],
        message: 'Dialogues must be sorted by createdAt and id',
      });
    }

    if (snapshot.phase === 'investigating') {
      if (snapshot.finalSubmission !== null) {
        context.addIssue({
          code: 'custom',
          path: ['finalSubmission'],
          message: 'An investigating game cannot have a final submission',
        });
      }
      if (snapshot.result !== null) {
        context.addIssue({
          code: 'custom',
          path: ['result'],
          message: 'An investigating game cannot have a result',
        });
      }
      if (snapshot.finishedAt !== null) {
        context.addIssue({
          code: 'custom',
          path: ['finishedAt'],
          message: 'An investigating game cannot be finished',
        });
      }
    }

    if (snapshot.phase === 'completed') {
      if (snapshot.finalSubmission === null) {
        context.addIssue({
          code: 'custom',
          path: ['finalSubmission'],
          message: 'A completed game requires a final submission',
        });
      }
      if (snapshot.result === null) {
        context.addIssue({
          code: 'custom',
          path: ['result'],
          message: 'A completed game requires a result and resolution',
        });
      }
      if (snapshot.finishedAt === null) {
        context.addIssue({
          code: 'custom',
          path: ['finishedAt'],
          message: 'A completed game requires finishedAt',
        });
      }
    }

    if (snapshot.phase === 'abandoned') {
      if (snapshot.result !== null) {
        context.addIssue({
          code: 'custom',
          path: ['result'],
          message: 'An abandoned game cannot contain a result or resolution',
        });
      }
      if (snapshot.finishedAt === null) {
        context.addIssue({
          code: 'custom',
          path: ['finishedAt'],
          message: 'An abandoned game requires finishedAt',
        });
      }
    }

    const suspectIds = new Set(snapshot.suspects.map((suspect) => suspect.id));
    if (snapshot.finalSubmission !== null && !suspectIds.has(snapshot.finalSubmission.suspectId)) {
      context.addIssue({
        code: 'custom',
        path: ['finalSubmission', 'suspectId'],
        message: 'The submitted suspect must belong to the pinned case',
      });
    }
    if (snapshot.result !== null && !suspectIds.has(snapshot.result.resolution.suspectId)) {
      context.addIssue({
        code: 'custom',
        path: ['result', 'resolution', 'suspectId'],
        message: 'The resolution suspect must belong to the pinned case',
      });
    }
  });

export type GamePhase = z.infer<typeof GamePhaseSchema>;
export type FinalVerdict = z.infer<typeof FinalVerdictSchema>;
export type FinalSubmission = z.infer<typeof FinalSubmissionSchema>;
export type CaseResolution = z.infer<typeof CaseResolutionSchema>;
export type GameResult = z.infer<typeof GameResultSchema>;
export type GameSnapshot = z.infer<typeof GameSnapshotSchema>;
