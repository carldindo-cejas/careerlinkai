import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type {
  AssessmentAssignment,
  AssessmentAttempt,
  AssessmentResult,
  AssessmentTemplate,
  ProfileOptions,
  StudentProfile,
  UpdateProfilePayload,
} from '@/types/assessment';
import type { Paginated } from '@/types/class';

/**
 * The results-listing endpoints paginate on the server (§19, audit A1/M6) so no single response
 * can approach the Free-plan subrequest ceiling. The current UI still wants the whole list, so
 * the service layer walks the pages and flattens them — the public `Promise<AssessmentResult[]>`
 * contract, and every hook and component above it, is unchanged. At thesis scale this is one
 * request for a student and at most two for a class (max 50 rows/page).
 */
const RESULTS_PAGE_SIZE = 50;

async function fetchAllResults(path: string): Promise<AssessmentResult[]> {
  const items: AssessmentResult[] = [];
  let page = 1;
  let lastPage = 1;

  do {
    const data = await unwrap(
      httpClient.get<ApiSuccess<Paginated<AssessmentResult>>>(path, {
        params: { page, per_page: RESULTS_PAGE_SIZE },
      }),
    );

    items.push(...data.items);
    lastPage = data.pagination.last_page;
    page += 1;
  } while (page <= lastPage);

  return items;
}

/**
 * The assessment engine (FULLPLAN §20, Phase 3).
 *
 * Split by *who is asking*, because the API is: the student endpoints resolve "me" from the
 * token and carry no student id at all, while the counselor endpoints name a class or an
 * attempt. That is not an accident of routing — reading someone's assessment data (§40, the most
 * sensitive data in the system) should never be reachable from a route that means "mine".
 */
export const studentAssessmentApi = {
  // Profile (§37) ----------------------------------------------------------

  getProfile(): Promise<StudentProfile> {
    return unwrap(httpClient.get<ApiSuccess<StudentProfile>>('/student/profile'));
  },

  updateProfile(payload: UpdateProfilePayload): Promise<StudentProfile> {
    return unwrap(httpClient.patch<ApiSuccess<StudentProfile>>('/student/profile', payload));
  },

  /** The grade-level and strand lookups the form's selects are built from (migration 0017). */
  getProfileOptions(): Promise<ProfileOptions> {
    return unwrap(httpClient.get<ApiSuccess<ProfileOptions>>('/student/profile/options'));
  },

  // The player (§37) -------------------------------------------------------

  listAssignments(): Promise<AssessmentAssignment[]> {
    return unwrap(httpClient.get<ApiSuccess<AssessmentAssignment[]>>('/student/assignments'));
  },

  /**
   * Idempotent on the server: a student who double-taps Start, or refreshes the player, lands
   * back in the attempt they already have rather than being told they cannot start one.
   */
  start(assignmentId: string): Promise<AssessmentAttempt> {
    return unwrap(
      httpClient.post<ApiSuccess<AssessmentAttempt>>(
        `/student/assignments/${assignmentId}/start`,
      ),
    );
  },

  getAttempt(attemptId: string): Promise<AssessmentAttempt> {
    return unwrap(httpClient.get<ApiSuccess<AssessmentAttempt>>(`/student/attempts/${attemptId}`));
  },

  /**
   * Saves (or changes) one answer. An upsert: changing your mind on question 7 updates the
   * answer rather than stacking a second one.
   *
   * Note what is **not** in this payload: a score. The server copies it from the selected option
   * (§13.5). A client that could send its own score would be scoring its own assessment.
   */
  async saveAnswer(
    attemptId: string,
    questionId: string,
    selectedOptionId: string,
  ): Promise<void> {
    await httpClient.post(`/student/attempts/${attemptId}/answers`, {
      question_id: questionId,
      selected_option_id: selectedOptionId,
    });
  },

  /**
   * Finalize. Scoring runs inline on the server (§24) and **the result comes back in this
   * response** — no polling, no spinner waiting on a queue. The student is sitting there.
   */
  submit(attemptId: string): Promise<AssessmentResult> {
    return unwrap(
      httpClient.post<ApiSuccess<AssessmentResult>>(`/student/attempts/${attemptId}/submit`),
    );
  },

  // Results (§37) ----------------------------------------------------------

  listResults(): Promise<AssessmentResult[]> {
    return fetchAllResults('/student/results');
  },

  getResult(attemptId: string): Promise<AssessmentResult> {
    return unwrap(httpClient.get<ApiSuccess<AssessmentResult>>(`/student/results/${attemptId}`));
  },
};

export const counselorAssessmentApi = {
  /** The instruments this counselor may assign: the global RIASEC/SCCT, plus their own. */
  listTemplates(): Promise<AssessmentTemplate[]> {
    return unwrap(
      httpClient.get<ApiSuccess<AssessmentTemplate[]>>('/counselor/assessment-templates'),
    );
  },

  listAssignments(classId: string): Promise<AssessmentAssignment[]> {
    return unwrap(
      httpClient.get<ApiSuccess<AssessmentAssignment[]>>(
        `/counselor/classes/${classId}/assignments`,
      ),
    );
  },

  assign(
    classId: string,
    versionId: string,
    deadline?: string | null,
  ): Promise<AssessmentAssignment> {
    return unwrap(
      httpClient.post<ApiSuccess<AssessmentAssignment>>(
        `/counselor/classes/${classId}/assignments`,
        { assessment_version_id: versionId, deadline: deadline || null },
      ),
    );
  },

  /**
   * Closing an assignment is not a status flip: it **expires every attempt still in progress**
   * underneath it (§21). The UI says so before sending this.
   */
  close(assignmentId: string): Promise<AssessmentAssignment> {
    return unwrap(
      httpClient.patch<ApiSuccess<AssessmentAssignment>>(
        `/counselor/assignments/${assignmentId}`,
        { status: 'CLOSED' },
      ),
    );
  },

  listClassResults(classId: string): Promise<AssessmentResult[]> {
    return fetchAllResults(`/counselor/classes/${classId}/results`);
  },

  /**
   * The §21 retake — the counselor's act, never the student's. It voids the scored attempt
   * (EXPIRED, kept as history) so the student can start fresh; the UI confirms before
   * sending because this destroys a standing result.
   */
  async resetAttempt(attemptId: string): Promise<void> {
    await httpClient.post(`/counselor/attempts/${attemptId}/reset`);
  },
};
