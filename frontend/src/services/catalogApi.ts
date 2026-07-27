import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type {
  CanonicalProgram,
  Career,
  College,
  CreateCanonicalProgramPayload,
  CreateCareerPayload,
  CreateCollegePayload,
  CreateProgramPayload,
  EmploymentOutlook,
  Program,
  ProgramOffering,
  UpdateCanonicalProgramPayload,
  UpdateCareerPayload,
  UpdateCollegePayload,
  UpdateProgramPayload,
} from '@/types/catalog';
import type { Paginated } from '@/types/class';

/**
 * The academic catalog (FULLPLAN §20, Phase 2). Admin only.
 *
 * The nesting mirrors the API's: programs are *created and listed* under their college and
 * *edited* by their own id. A program cannot exist without a college, but once it does, it
 * has an identity of its own — and it cannot be moved between institutions, which is why
 * there is no `college_id` in any payload here.
 */
export const catalogApi = {
  // Colleges ---------------------------------------------------------------

  listColleges(): Promise<Paginated<College>> {
    return unwrap(httpClient.get<ApiSuccess<Paginated<College>>>('/admin/colleges'));
  },

  /** Includes the nested programs, each with its linked careers (§20). */
  getCollege(id: string): Promise<College> {
    return unwrap(httpClient.get<ApiSuccess<College>>(`/admin/colleges/${id}`));
  },

  createCollege(payload: CreateCollegePayload): Promise<College> {
    return unwrap(httpClient.post<ApiSuccess<College>>('/admin/colleges', payload));
  },

  updateCollege(id: string, payload: UpdateCollegePayload): Promise<College> {
    return unwrap(httpClient.patch<ApiSuccess<College>>(`/admin/colleges/${id}`, payload));
  },

  async removeCollege(id: string): Promise<void> {
    await httpClient.delete(`/admin/colleges/${id}`);
  },

  // Programs ---------------------------------------------------------------

  createProgram(collegeId: string, payload: CreateProgramPayload): Promise<Program> {
    return unwrap(
      httpClient.post<ApiSuccess<Program>>(`/admin/colleges/${collegeId}/programs`, payload),
    );
  },

  updateProgram(id: string, payload: UpdateProgramPayload): Promise<Program> {
    return unwrap(httpClient.patch<ApiSuccess<Program>>(`/admin/programs/${id}`, payload));
  },

  async removeProgram(id: string): Promise<void> {
    await httpClient.delete(`/admin/programs/${id}`);
  },

  // Careers ----------------------------------------------------------------

  listCareers(): Promise<Paginated<Career>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<Career>>>('/admin/careers', {
        // The mapping picker needs the whole catalog in one list, not page one of it.
        params: { per_page: 100 },
      }),
    );
  },

  /** The employment-outlook lookup (backend migration 0013) that populates the careers dropdown. */
  listEmploymentOutlooks(): Promise<EmploymentOutlook[]> {
    return unwrap(
      httpClient.get<ApiSuccess<EmploymentOutlook[]>>('/admin/employment-outlooks'),
    );
  },

  createCareer(payload: CreateCareerPayload): Promise<Career> {
    return unwrap(httpClient.post<ApiSuccess<Career>>('/admin/careers', payload));
  },

  updateCareer(id: string, payload: UpdateCareerPayload): Promise<Career> {
    return unwrap(httpClient.patch<ApiSuccess<Career>>(`/admin/careers/${id}`, payload));
  },

  async removeCareer(id: string): Promise<void> {
    await httpClient.delete(`/admin/careers/${id}`);
  },

  // The mapping ------------------------------------------------------------

  /**
   * Linking a career is not cosmetic: §27 averages the RIASEC compatibility of every career
   * linked to a program to produce that program's own score. Both calls return the updated
   * program with its careers, so the caller never has to refetch to redraw the mapping.
   */
  attachCareer(programId: string, careerId: string): Promise<Program> {
    return unwrap(
      httpClient.post<ApiSuccess<Program>>(`/admin/programs/${programId}/careers`, {
        career_id: careerId,
      }),
    );
  },

  detachCareer(programId: string, careerId: string): Promise<Program> {
    return unwrap(
      httpClient.delete<ApiSuccess<Program>>(`/admin/programs/${programId}/careers/${careerId}`),
    );
  },

  /**
   * §20 "Public / Health" (Phase 6): the unauthenticated catalog browse the landing page
   * renders. Active chains only, thin shape — a prospectus, not the admin view.
   */
  publicPrograms(): Promise<PublicCatalog> {
    return unwrap(httpClient.get<ApiSuccess<PublicCatalog>>('/programs/public'));
  },

  // --- The canonical program catalog (migration 0018) ---------------------------------------
  //
  // `program_catalog` is what makes "which colleges offer this program?" a join rather than a
  // string match. The 0018 backfill grouped existing programs on their normalized code, which is a
  // guess — these endpoints are how an admin corrects it.

  listCanonicalPrograms(page = 1, perPage = 50): Promise<Paginated<CanonicalProgram>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<CanonicalProgram>>>('/admin/canonical-programs', {
        params: { page, per_page: perPage },
      }),
    );
  },

  /** The unpaginated picker for the program form's combobox. */
  canonicalProgramOptions(): Promise<CanonicalProgram[]> {
    return unwrap(
      httpClient.get<ApiSuccess<CanonicalProgram[]>>('/admin/canonical-programs/options'),
    );
  },

  canonicalProgramColleges(
    id: string,
  ): Promise<{ canonical: CanonicalProgram; offerings: ProgramOffering[] }> {
    return unwrap(
      httpClient.get<ApiSuccess<{ canonical: CanonicalProgram; offerings: ProgramOffering[] }>>(
        `/admin/canonical-programs/${id}/colleges`,
      ),
    );
  },

  createCanonicalProgram(payload: CreateCanonicalProgramPayload): Promise<CanonicalProgram> {
    return unwrap(
      httpClient.post<ApiSuccess<CanonicalProgram>>('/admin/canonical-programs', payload),
    );
  },

  updateCanonicalProgram(
    id: string,
    payload: UpdateCanonicalProgramPayload,
  ): Promise<CanonicalProgram> {
    return unwrap(
      httpClient.patch<ApiSuccess<CanonicalProgram>>(`/admin/canonical-programs/${id}`, payload),
    );
  },

  /**
   * Absorb `id` into `targetId`: every offering is re-pointed and `id` is retired. Not reversible
   * from the UI, so the caller confirms first.
   */
  mergeCanonicalPrograms(
    id: string,
    targetId: string,
  ): Promise<{ target: CanonicalProgram; offerings_moved: number }> {
    return unwrap(
      httpClient.post<ApiSuccess<{ target: CanonicalProgram; offerings_moved: number }>>(
        `/admin/canonical-programs/${id}/merge`,
        { target_id: targetId },
      ),
    );
  },
};

export interface PublicCatalog {
  colleges: {
    id: string;
    name: string;
    programs: {
      id: string;
      code: string;
      name: string;
      recommended_strand: string | null;
    }[];
  }[];
}
