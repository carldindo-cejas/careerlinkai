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
   * The counselor detail page (prompt-driven): every student in this counselor's classes, with
   * their Holland Code and top career/program recommendations. Bounded roster, returned whole.
   */
  students(id: string): Promise<CounselorStudents> {
    return unwrap(
      httpClient.get<ApiSuccess<CounselorStudents>>(`/admin/counselors/${id}/students`),
    );
  },
};
