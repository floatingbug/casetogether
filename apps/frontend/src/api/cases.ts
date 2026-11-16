import { CaseListResponseSchema, type CaseSummary } from '@casetogether/shared';
import { requestData } from './http';

export interface CasesApi {
  listCases(): Promise<CaseSummary[]>;
}

export function createCasesApi(options: { fetcher?: typeof fetch } = {}): CasesApi {
  return {
    async listCases() {
      const response = await requestData(
        {
          method: 'GET',
          path: '/cases',
          expectedStatuses: [200],
          responseSchema: CaseListResponseSchema,
        },
        options,
      );
      return response.data.items;
    },
  };
}

export const casesApi = createCasesApi();
