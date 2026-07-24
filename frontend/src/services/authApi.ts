import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type { User } from '@/types/user';

/**
 * Staff auth client (FULLPLAN §20).
 *
 * No component ever calls axios directly — it goes component → hook → this module (§36).
 */

export interface LoginPayload {
  email: string;
  password: string;
}

export interface LoginResult {
  user: User;
  token: string;
}

export interface ChangePasswordPayload {
  current_password: string;
  password: string;
  password_confirmation: string;
}

export const authApi = {
  login(payload: LoginPayload): Promise<LoginResult> {
    return unwrap(httpClient.post<ApiSuccess<LoginResult>>('/auth/login', payload));
  },

  me(): Promise<User> {
    return unwrap(httpClient.get<ApiSuccess<User>>('/auth/me'));
  },

  async logout(): Promise<void> {
    await httpClient.post('/auth/logout');
  },

  /**
   * Revoke a token that was never stored. The interceptor attaches the token from the
   * auth store, which is empty when a login screen refuses a wrong-role sign-in — so
   * this variant carries the freshly issued token explicitly.
   */
  async revoke(token: string): Promise<void> {
    await httpClient.post('/auth/logout', undefined, {
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  async changePassword(payload: ChangePasswordPayload): Promise<void> {
    await httpClient.post('/auth/change-password', payload);
  },
};
