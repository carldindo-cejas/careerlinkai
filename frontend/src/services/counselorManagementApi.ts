import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type { Paginated } from '@/types/class';
import type {
  CounselorStudents,
  CreateCounselorPayload,
  CreatedCounselor,
  ManagedCounselor,
  UpdateCounselorPayload,
} from '@/types/platform';

/**
 * Counselor management (FULLPLAN §20 "Counselor management" — Phase 6, admin only).
 *
 * Creation never sends a password: the server generates the temporary one and returns it
 * exactly once in the creation response. Nothing in this module ever asks for it again.
 */
export const counselorManagementApi = {
  list(params: { page?: number; per_page?: number; search?: string; status?: string } = {}): Promise<
    Paginated<ManagedCounselor>
  > {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<ManagedCounselor>>>('/admin/counselors', { params }),
    );
  },

  create(payload: CreateCounselorPayload): Promise<CreatedCounselor> {
    return unwrap(httpClient.post<ApiSuccess<CreatedCounselor>>('/admin/counselors', payload));
  },

  update(id: string, payload: UpdateCounselorPayload): Promise<ManagedCounselor> {
    return unwrap(
      httpClient.patch<ApiSuccess<ManagedCounselor>>(`/admin/counselors/${id}`, payload),
    );
  },

  async remove(id: string): Promise<void> {
    await httpClient.delete(`/admin/counselors/${id}`);
  },

  /**
   * Issue a counselor a fresh temporary password (audit C2) — **the staff account recovery path.**
   *
   * This is the only way a counselor who has forgotten their password can get back in. The
   * self-service `/auth/forgot-password` flow cannot serve them: it withholds its token outside
   * `local`, stores only the token's hash so nobody can read it back out, and v1 has no email
   * channel to deliver it through. Before this endpoint the outcome was a permanent lockout
   * recoverable only by hand-written SQL against production.
   *
   * Returns the same shape as `create` — the plaintext exactly once, never retrievable again, and
   * already flagged `must_change_password` so it dies at the counselor's next sign-in.
   */
  resetPassword(id: string): Promise<CreatedCounselor> {
    return unwrap(
      httpClient.post<ApiSuccess<CreatedCounselor>>(`/admin/counselors/${id}/reset-password`),
    );
  },

  /**
   * The counselor detail page (prompt-driven): every student in this counselor's classes, with
   * their Holland Code and top career/program recommendations. Bounded roster, returned whole.
   */
  students(id: string): Promise<CounselorStudents> {
    return unwrap(
      httpClient.get<ApiSuccess<CounselorStudents>>(`/admin/counselors/${id}/students`),
    );
  },
};
