import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type { ConfirmedStudent, PreviewedStudent, RosterEntry } from '@/types/class';

/**
 * Bulk roster provisioning (FULLPLAN §20, §57).
 *
 * Two requests, deliberately: `preview` proposes usernames and persists nothing, the
 * counselor reviews and edits, then `confirm` creates the accounts. There is no student
 * self-registration anywhere in the system.
 */
export const rosterApi = {
  list(classId: string): Promise<RosterEntry[]> {
    return unwrap(
      httpClient.get<ApiSuccess<RosterEntry[]>>(`/counselor/classes/${classId}/students`),
    );
  },

  /** Proposes usernames for pasted names. Writes nothing. */
  preview(classId: string, names: string[]): Promise<PreviewedStudent[]> {
    return unwrap(
      httpClient.post<ApiSuccess<{ students: PreviewedStudent[] }>>(
        `/counselor/classes/${classId}/students/preview`,
        { names },
      ),
    ).then((data) => data.students);
  },

  /**
   * Creates the accounts. One username collision rejects the whole batch (§13.2) — there
   * is no half-provisioned roster — and the server re-checks every username, because the
   * counselor may have edited any of them since preview.
   */
  confirm(classId: string, students: ConfirmedStudent[]): Promise<RosterEntry[]> {
    return unwrap(
      httpClient.post<ApiSuccess<RosterEntry[]>>(
        `/counselor/classes/${classId}/students/confirm`,
        { students },
      ),
    );
  },

  /** `studentId` is the student's *user* id, not the enrollment id (§20). */
  async remove(classId: string, studentId: string): Promise<void> {
    await httpClient.delete(`/counselor/classes/${classId}/students/${studentId}`);
  },
};
