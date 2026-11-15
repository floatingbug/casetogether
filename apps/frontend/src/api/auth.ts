import {
  LoginRequestSchema,
  RegisterRequestSchema,
  UserResponseSchema,
  type LoginRequest,
  type PublicUser,
  type RegisterRequest,
} from '@casetogether/shared';
import { requestData, requestNoContent } from './http';

export interface AuthApi {
  getMe(): Promise<PublicUser>;
  login(request: LoginRequest): Promise<PublicUser>;
  register(request: RegisterRequest): Promise<PublicUser>;
  logout(): Promise<void>;
}

export function createAuthApi(options: { fetcher?: typeof fetch } = {}): AuthApi {
  return {
    async getMe() {
      const response = await requestData(
        {
          method: 'GET',
          path: '/me',
          expectedStatuses: [200],
          responseSchema: UserResponseSchema,
        },
        options,
      );
      return response.data;
    },

    async login(request) {
      const response = await requestData(
        {
          method: 'POST',
          path: '/auth/login',
          expectedStatuses: [200],
          body: request,
          requestSchema: LoginRequestSchema,
          responseSchema: UserResponseSchema,
        },
        options,
      );
      return response.data;
    },

    async register(request) {
      const response = await requestData(
        {
          method: 'POST',
          path: '/auth/register',
          expectedStatuses: [201],
          body: request,
          requestSchema: RegisterRequestSchema,
          responseSchema: UserResponseSchema,
        },
        options,
      );
      return response.data;
    },

    async logout() {
      await requestNoContent(
        {
          method: 'POST',
          path: '/auth/logout',
          expectedStatuses: [204],
        },
        options,
      );
    },
  };
}

export const authApi = createAuthApi();
