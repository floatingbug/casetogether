import { z } from 'zod';

const normalizedString = z.string().trim().normalize('NFC');
const safeIntegerMaximum = Number.MAX_SAFE_INTEGER;

export const OpaqueIdSchema = normalizedString
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const UserIdSchema = OpaqueIdSchema.brand<'UserId'>();
export const RoomIdSchema = OpaqueIdSchema.brand<'RoomId'>();
export const CaseIdSchema = OpaqueIdSchema.brand<'CaseId'>();
export const SessionIdSchema = OpaqueIdSchema.brand<'SessionId'>();
export const SuspectIdSchema = OpaqueIdSchema.brand<'SuspectId'>();
export const QuestionIdSchema = OpaqueIdSchema.brand<'QuestionId'>();
export const ClueIdSchema = OpaqueIdSchema.brand<'ClueId'>();
export const EventIdSchema = OpaqueIdSchema.brand<'EventId'>();
export const MessageIdSchema = OpaqueIdSchema.brand<'MessageId'>();
export const DialogueIdSchema = OpaqueIdSchema.brand<'DialogueId'>();

export const CaseVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
export const ClientRequestIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/);

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const ServerIsoDateTimeSchema = IsoDateTimeSchema.regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
).refine((value) => new Date(value).toISOString() === value, {
  message: 'Expected a valid UTC timestamp with milliseconds',
});

export const EmailSchema = z.string().trim().toLowerCase().max(254).email();
export const PasswordSchema = z.string().min(12).max(128);
export const DisplayNameSchema = normalizedString
  .min(1)
  .max(32)
  .regex(/^[^\p{Cc}]+$/u, 'Control characters are not allowed');
export const ChatContentSchema = normalizedString.min(1).max(1000);
export const FreeTextQuestionSchema = normalizedString.min(1).max(500);
export const DialogueTextSchema = normalizedString.min(1).max(4000);
export const VersionSchema = z.number().int().min(1).max(safeIntegerMaximum);
export const NonNegativeIntegerSchema = z.number().int().min(0).max(safeIntegerMaximum);
export const InvitationCodeSchema = normalizedString.regex(
  /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/,
);

export type OpaqueId = z.infer<typeof OpaqueIdSchema>;
export type UserId = z.infer<typeof UserIdSchema>;
export type RoomId = z.infer<typeof RoomIdSchema>;
export type CaseId = z.infer<typeof CaseIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type SuspectId = z.infer<typeof SuspectIdSchema>;
export type QuestionId = z.infer<typeof QuestionIdSchema>;
export type ClueId = z.infer<typeof ClueIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;
export type DialogueId = z.infer<typeof DialogueIdSchema>;
export type CaseVersion = z.infer<typeof CaseVersionSchema>;
export type ClientRequestId = z.infer<typeof ClientRequestIdSchema>;
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type ServerIsoDateTime = z.infer<typeof ServerIsoDateTimeSchema>;
export type Email = z.infer<typeof EmailSchema>;
export type Password = z.infer<typeof PasswordSchema>;
export type DisplayName = z.infer<typeof DisplayNameSchema>;
export type ChatContent = z.infer<typeof ChatContentSchema>;
export type FreeTextQuestion = z.infer<typeof FreeTextQuestionSchema>;
export type DialogueText = z.infer<typeof DialogueTextSchema>;
export type Version = z.infer<typeof VersionSchema>;
export type InvitationCode = z.infer<typeof InvitationCodeSchema>;
