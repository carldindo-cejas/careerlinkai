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
 * The list query the three catalog lists share (backend `listCatalogQuerySchema`, audit F3/F4).
 *
 * Every field is optional and an omitted field means the server's default — page 1, 20 per page,
 * by name ascending, no filter. `search: undefined` is deliberately different from `search: ''`
 * only in that axios drops the former from the URL; the server treats both as "no filter", so a
 * cleared box cannot accidentally become a filter on the empty string.
 */
export interface CatalogListQuery {
  search?: string | undefined;
  status?: 'active' | 'archived' | undefined;
  page?: number | undefined;
  per_page?: number | undefined;
  sort?: 'name' | 'created_at' | undefined;
  direction?: 'asc' | 'desc' | undefined;
}

/** The same, plus the `code` sort that only canonical programmes have a column for. */
export interface CanonicalProgramListQuery extends Omit<CatalogListQuery, 'sort'> {
  sort?: 'name' | 'code' | 'created_at' | undefined;
}

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

  listColleges(query: CatalogListQuery = {}): Promise<Paginated<College>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<College>>>('/admin/colleges', { params: query }),
    );
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

  /**
   * **No longer requests "the whole catalog".** It used to send `per_page: 100` with a comment
   * saying the mapping picker needed every career in one list — which was true at 16 careers, false
   * at 101, and silent about the difference (audit F3). Both callers now send a real query: the
   * page sends its page and search, the picker sends its search term.
   */
  listCareers(query: CatalogListQuery = {}): Promise<Paginated<Career>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<Career>>>('/admin/careers', { params: query }),
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

  listCanonicalPrograms(
    query: CanonicalProgramListQuery = {},
  ): Promise<Paginated<CanonicalProgram>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<CanonicalProgram>>>('/admin/canonical-programs', {
        params: { per_page: 50, ...query },
      }),
    );
  },

  /**
   * The canonical-entry typeahead. Server-searched and server-capped at 20 — it used to request
   * every active entry with no limit, and (worse) nothing in the app called it at all.
   */
  canonicalProgramOptions(search?: string): Promise<CanonicalProgram[]> {
    return unwrap(
      httpClient.get<ApiSuccess<CanonicalProgram[]>>('/admin/canonical-programs/options', {
        params: { search },
      }),
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
