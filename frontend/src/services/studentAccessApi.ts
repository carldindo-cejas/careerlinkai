import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type { StudentClassSummary } from '@/types/class';
import type { User } from '@/types/user';

/**
 * Passwordless student access (FULLPLAN §38).
 *
 * The only endpoint in the system a student can reach without already being
 * authenticated. There is no password in this payload, and there is no other student
 * sign-in path — a `password` field appearing anywhere near this module is a bug.
 */

export interface JoinClassPayload {
  class_code: string;
  username: string;
}

/**
 * Step one's answer: **whose account is this?** No token, and nobody's session has been touched.
 *
 * The two-step join is the fix for the 18 September 2026 incident, where 61 of 79 joins in one
 * hour ended a session somebody else was using — students were typing each other's roster numbers
 * (`1.1`, `1.11`) and each sign-in silently evicted the last. A student recognises their own name;
 * that is the entire mechanism.
 */
export interface JoinConfirmation {
  confirmation_required: true;
  student_name: string;
  class: StudentClassSummary;
  username: string;
  /** True when confirming will sign another device out. Warned about before it happens. */
  active_session: boolean;
}

export interface JoinClassResult {
  confirmation_required: false;
  user: User;
  /** No join code and no counselor id — the code never travels back out (§38). */
  class: StudentClassSummary;
  username: string;
  token: string;
}

export const studentAccessApi = {
  /** Resolve the credentials and ask "is this you?" — issues nothing. */
  confirm(payload: JoinClassPayload): Promise<JoinConfirmation> {
    return unwrap(
      httpClient.post<ApiSuccess<JoinConfirmation>>('/student-access/join', payload),
    );
  },

  /**
   * Take the session. `confirm: true` is what separates this from the call above, server-side —
   * a client that never sends it can never take somebody's session over.
   */
  join(payload: JoinClassPayload): Promise<JoinClassResult> {
    return unwrap(
      httpClient.post<ApiSuccess<JoinClassResult>>('/student-access/join', {
        ...payload,
        confirm: true,
      }),
    );
  },
};
