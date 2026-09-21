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


  // --- Counselor self-signup (migration 0034) ------------------------------------------

  /**
   * Whether the sign-up form should render at all.
   *
   * Asked rather than assumed, on both the sign-in screen and the form itself. The server is the
   * authority — it 403s a submission when registration is closed regardless of what the client
   * believes — so this exists to avoid offering a door that is locked, not to enforce the lock.
   */
  signupStatus(): Promise<{ counselor_signup_open: boolean }> {
    return unwrap(
      httpClient.get<ApiSuccess<{ counselor_signup_open: boolean }>>('/auth/signup-status'),
    );
  },

  /**
   * Step 1. Resolves to the local-development code echo (`{ verification_code }`) or `null`
   * everywhere else — **and the difference must never change what the screen says**: the response
   * is deliberately identical for a registered and an unregistered address, so a UI that branched
   * on the presence of a code would rebuild the enumeration oracle the API refuses to be.
   */
  counselorSignup(payload: CounselorSignupPayload): Promise<SignupAcknowledgement> {
    return unwrap(
      httpClient.post<ApiSuccess<SignupAcknowledgement>>('/auth/counselor-signup', payload),
    );
  },

  resendSignupCode(email: string): Promise<SignupAcknowledgement> {
    return unwrap(
      httpClient.post<ApiSuccess<SignupAcknowledgement>>('/auth/counselor-signup/resend', {
        email,
      }),
    );
  },

  /** Step 2. No token comes back: the counselor signs in through `/auth/login` like anybody else. */
  async verifySignupCode(email: string, code: string): Promise<void> {
    await httpClient.post('/auth/counselor-signup/verify', { email, code });
  },
};

export interface CounselorSignupPayload {
  email: string;
  password: string;
  password_confirmation: string;
  first_name: string;
  last_name: string;
  phone?: string;
  employee_number?: string;
  specialization?: string;
}

/** Null outside local development — see `counselorSignup`. */
export type SignupAcknowledgement = { verification_code: string } | null;
