import { z } from 'zod';
import {
  CaseIdSchema,
  ClueIdSchema,
  DialogueIdSchema,
  DialogueTextSchema,
  FreeTextQuestionSchema,
  QuestionIdSchema,
  ServerIsoDateTimeSchema,
  SuspectIdSchema,
} from './primitives.js';
import { PublicUserSchema } from './rooms.js';

const normalizedText = (maximumLength: number) =>
  z.string().trim().normalize('NFC').min(1).max(maximumLength);

export const CaseSummarySchema = z
  .object({
    id: CaseIdSchema,
    title: normalizedText(200),
    description: normalizedText(2000),
    estimatedDurationMinutes: z.number().int().min(5).max(240),
  })
  .strict();

export const CatalogQuestionSchema = z
  .object({
    questionId: QuestionIdSchema,
    suspectId: SuspectIdSchema,
    text: FreeTextQuestionSchema,
  })
  .strict();

export const PublicSuspectSchema = z
  .object({
    id: SuspectIdSchema,
    displayName: normalizedText(100),
    publicDescription: normalizedText(2000),
  })
  .strict();

export const ClueSchema = z
  .object({
    id: ClueIdSchema,
    title: normalizedText(200),
    text: normalizedText(4000),
    discoveredAt: ServerIsoDateTimeSchema,
  })
  .strict();

export const DialogueModeSchema = z.enum(['catalog', 'free_text']);
export const AnswerSourceSchema = z.enum(['reference', 'ai', 'fallback']);

export const SuspectDialogueSchema = z
  .object({
    id: DialogueIdSchema,
    suspectId: SuspectIdSchema,
    mode: DialogueModeSchema,
    questionId: QuestionIdSchema.nullable(),
    questionText: FreeTextQuestionSchema,
    answerText: DialogueTextSchema,
    answerSource: AnswerSourceSchema,
    askedBy: PublicUserSchema,
    createdAt: ServerIsoDateTimeSchema,
  })
  .strict()
  .superRefine((dialogue, context) => {
    if (dialogue.mode === 'catalog' && dialogue.questionId === null) {
      context.addIssue({
        code: 'custom',
        path: ['questionId'],
        message: 'Catalog dialogue requires a questionId',
      });
    }
    if (dialogue.mode === 'free_text' && dialogue.questionId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['questionId'],
        message: 'Free-text dialogue must not contain a questionId',
      });
    }
    if (dialogue.mode === 'free_text' && dialogue.answerSource !== 'ai') {
      context.addIssue({
        code: 'custom',
        path: ['answerSource'],
        message: 'Free-text dialogue can only use an AI answer source',
      });
    }
    if (
      dialogue.mode === 'catalog' &&
      !['reference', 'ai', 'fallback'].includes(dialogue.answerSource)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['answerSource'],
        message: 'Invalid catalog answer source',
      });
    }
  });

export type CaseSummary = z.infer<typeof CaseSummarySchema>;
export type CatalogQuestion = z.infer<typeof CatalogQuestionSchema>;
export type PublicSuspect = z.infer<typeof PublicSuspectSchema>;
export type Clue = z.infer<typeof ClueSchema>;
export type DialogueMode = z.infer<typeof DialogueModeSchema>;
export type AnswerSource = z.infer<typeof AnswerSourceSchema>;
export type SuspectDialogue = z.infer<typeof SuspectDialogueSchema>;
