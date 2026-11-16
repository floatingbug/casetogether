import type { AiProviderResult, AuthorizedDialogueContext, DialogueProvider } from './contracts.js';

export type MockDialogueHandler = (
  context: AuthorizedDialogueContext,
) => AiProviderResult | Promise<AiProviderResult>;

/** Deterministic local test port. It has no transport and cannot perform a live provider call. */
export class MockDialogueProvider implements DialogueProvider {
  readonly #handler: MockDialogueHandler;
  readonly #calls: AuthorizedDialogueContext[] = [];

  constructor(handler: MockDialogueHandler) {
    this.#handler = handler;
  }

  get callCount(): number {
    return this.#calls.length;
  }

  get calls(): readonly AuthorizedDialogueContext[] {
    return this.#calls.map((context) => structuredClone(context));
  }

  generateDialogue(context: AuthorizedDialogueContext): Promise<AiProviderResult> {
    const snapshot = structuredClone(context);
    this.#calls.push(snapshot);
    return Promise.resolve().then(() => this.#handler(snapshot));
  }
}
