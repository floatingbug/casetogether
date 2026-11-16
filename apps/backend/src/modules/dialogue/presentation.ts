import { GameEventSchema, SuspectDialogueSchema, type AnswerSource } from '@casetogether/shared';
import type {
  GameCommandSuccess,
  GameEngineState,
  RecipientGameEvent,
} from '../../game-engine/types.js';

export function applyCataloguePresentation(
  success: GameCommandSuccess,
  answerText: string,
  answerSource: AnswerSource,
): { state: GameEngineState; recipientEvents: readonly RecipientGameEvent[] } {
  const stored = success.state.dialogues.at(-1);
  if (stored === undefined || stored.dialogue.mode !== 'catalog') {
    throw new Error('A successful catalog action omitted its new dialogue');
  }
  const dialogue = SuspectDialogueSchema.parse({
    ...stored.dialogue,
    answerText,
    answerSource,
  });
  const dialogues = success.state.dialogues.map((candidate) =>
    candidate.dialogue.id === dialogue.id ? { ...candidate, dialogue } : candidate,
  );
  const events = success.state.events.map((event) => {
    if (event.eventId !== success.eventId) {
      return event;
    }
    const deliveries = event.deliveries.map((delivery) => {
      if (
        delivery.event?.type !== 'suspect.answered' ||
        delivery.event.payload.dialogue?.id !== dialogue.id
      ) {
        return delivery;
      }
      return {
        ...delivery,
        event: GameEventSchema.parse({
          ...delivery.event,
          payload: { ...delivery.event.payload, dialogue },
        }),
      };
    });
    return { ...event, deliveries };
  });
  const projected = events.find((event) => event.eventId === success.eventId);
  if (projected === undefined) {
    throw new Error('The persisted catalog event is missing after presentation');
  }
  return {
    state: { ...success.state, dialogues, events },
    recipientEvents: projected.deliveries,
  };
}
