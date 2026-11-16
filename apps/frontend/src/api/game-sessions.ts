import {
  FinalSubmissionRequestSchema,
  GameResponseSchema,
  type FinalSubmissionRequest,
  type GameSnapshot,
} from '@casetogether/shared';
import { requestData } from './http';

export interface GameSessionsApi {
  getSession(sessionId: string): Promise<GameSnapshot>;
  submitFinalSolution(
    request: FinalSubmissionRequest & { sessionId: string },
  ): Promise<GameSnapshot>;
}

export function createGameSessionsApi(options: { fetcher?: typeof fetch } = {}): GameSessionsApi {
  return {
    async getSession(sessionId) {
      const response = await requestData(
        {
          method: 'GET',
          path: `/sessions/${encodeURIComponent(sessionId)}`,
          expectedStatuses: [200],
          responseSchema: GameResponseSchema,
        },
        options,
      );
      return response.data;
    },

    async submitFinalSolution({ sessionId, ...request }) {
      const response = await requestData(
        {
          method: 'POST',
          path: `/sessions/${encodeURIComponent(sessionId)}/final-submission`,
          expectedStatuses: [200],
          body: request,
          requestSchema: FinalSubmissionRequestSchema,
          responseSchema: GameResponseSchema,
        },
        options,
      );
      return response.data;
    },
  };
}

export const gameSessionsApi = createGameSessionsApi();
