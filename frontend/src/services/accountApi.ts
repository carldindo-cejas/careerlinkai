import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type { User } from '@/types/user';

/**
 * A staff member's edits to **their own** account (`/counselor/profile`, 2026-09-20).
 *
 * Its own module rather than three more methods on `authApi`, and the reason is a budget rather
 * than taste: `authApi` is reached from `AppShell` (sign-out) on every screen in every shell, so
 * anything added to it is downloaded by a student opening their dashboard on school wifi — and
 * the student route is held to 560 KiB by `platform-gates.mjs`. This file is imported by exactly
 * one page and rides in the counselor chunk with it.
 *
 * Changing a *password* stays on `authApi`, and not by oversight: that endpoint is also the
 * forced-rotation screen every role can be sent to, so it genuinely belongs to the shared surface.
 */

/**
 * Every field is optional and an omitted one is left alone by the server, which is what lets the
 * cards on that page each submit only what they own rather than round-tripping the whole account.
 * `null` is a *clear* — the distinction `undefined` cannot carry — so the optional fields are
 * typed `| null` rather than merely optional.
 */
export interface UpdateAccountPayload {
  /** The administrator case: they have no counselor profile for a first/last name to live in. */
  name?: string;
  first_name?: string;
  last_name?: string;
  phone?: string | null;
  employee_number?: string | null;
  specialization?: string | null;
  bio?: string | null;
}

export interface ChangeEmailPayload {
  email: string;
  /** Not ceremony: the email is the login identifier and the reset destination (§38). */
  current_password: string;
}

export const accountApi = {
  /**
   * Both of these answer with the updated user in the same shape `/auth/me` does, so the caller
   * replaces the cached user from the response rather than refetching — the name is in the
   * sidebar, the top bar and the breadcrumb of the screen that submitted the form.
   */
  updateAccount(payload: UpdateAccountPayload): Promise<User> {
    return unwrap(httpClient.patch<ApiSuccess<User>>('/auth/profile', payload));
  },

  changeEmail(payload: ChangeEmailPayload): Promise<User> {
    return unwrap(httpClient.post<ApiSuccess<User>>('/auth/change-email', payload));
  },
};
