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

export interface JoinClassResult {
  user: User;
  /** No join code and no counselor id — the code never travels back out (§38). */
  class: StudentClassSummary;
  username: string;
  token: string;
}

export const studentAccessApi = {
  join(payload: JoinClassPayload): Promise<JoinClassResult> {
    return unwrap(httpClient.post<ApiSuccess<JoinClassResult>>('/student-access/join', payload));
  },
};
