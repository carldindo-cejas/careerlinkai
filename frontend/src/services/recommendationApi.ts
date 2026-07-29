import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type {
  CareerProgramsResponse,
  ChatTranscript,
  ChatTurn,
  ProgramCollegesResponse,
  RecommendationSet,
} from '@/types/recommendation';

/**
 * Recommendations (FULLPLAN §20, §27 — Phase 4).
 *
 * **`null` is a successful answer, not a failure.** A student who has not completed *both* RIASEC
 * and SCCT has no recommendations, and that is the ordinary state of most students most of the
 * time. The API answers 200 with `data: null` rather than 404 precisely so the client can tell
 * three genuinely different things apart:
 *
 *   - the request failed          → the hook's `isError`
 *   - you have none yet           → `data === null`
 *   - here they are               → a set
 *
 * That distinction is the whole substance of deviation D11, which existed because the Phase 3
 * screens could not make it and told students they had nothing to do while the endpoint was
 * 404ing. Shipping the recommendation screens with the same ambiguity would be a poor joke.
 */
export const recommendationApi = {
  /** Mine. There is no student id in this URL, so it cannot be made to mean anyone else's. */
  getMine(): Promise<RecommendationSet | null> {
    return unwrap(httpClient.get<ApiSuccess<RecommendationSet | null>>('/student/recommendations'));
  },

  /**
   * A counselor reading one of their own students (§4). The server 404s — deliberately, not 403s —
   * for a student outside their classes, so "not yours" and "not real" are indistinguishable.
   */
  getForStudent(studentId: string): Promise<RecommendationSet | null> {
    return unwrap(
      httpClient.get<ApiSuccess<RecommendationSet | null>>(
        `/counselor/students/${studentId}/recommendations`,
      ),
    );
  },

  /**
   * Rebuild my own recommendations from my latest results (audit C4).
   *
   * Two situations need this, and neither had any recovery before it existed. The first is a
   * generation that failed: recommendations are produced by an `AssessmentCompleted` listener whose
   * exceptions are deliberately swallowed (a failing listener must not turn a completed assessment
   * into a 500), so a transient error left a student with both assessments done and no cards, being
   * told to "complete both assessments". The second is slower and certain — the set is computed
   * once, against the catalog as it was that day, so every college added afterwards is invisible to
   * every existing student until this runs.
   *
   * Idempotent on the server: it replaces the student's whole set rather than appending, so
   * pressing it twice is indistinguishable from pressing it once. Rate-limited per student.
   */
  regenerateMine(): Promise<RecommendationSet | null> {
    return unwrap(
      httpClient.post<ApiSuccess<RecommendationSet | null>>('/student/recommendations/regenerate'),
    );
  },

  /** The same, performed by a counselor for one of their own students. Same 404-not-403 rule. */
  regenerateForStudent(studentId: string): Promise<RecommendationSet | null> {
    return unwrap(
      httpClient.post<ApiSuccess<RecommendationSet | null>>(
        `/counselor/students/${studentId}/recommendations/regenerate`,
      ),
    );
  },
};

/**
 * The recommendations chat assistant (migration 0019).
 *
 * Every endpoint means "mine" — there is no student id in any URL, so none of them can be made to
 * mean somebody else's conversation by editing a parameter. The recommendation context the model
 * sees is loaded **server-side** from the caller's token and is deliberately not something this
 * client can supply.
 */
export const chatApi = {
  getTranscript(): Promise<ChatTranscript> {
    return unwrap(httpClient.get<ApiSuccess<ChatTranscript>>('/student/chat'));
  },

  ask(message: string): Promise<ChatTurn> {
    return unwrap(httpClient.post<ApiSuccess<ChatTurn>>('/student/chat', { message }));
  },

  async clear(): Promise<void> {
    await httpClient.delete('/student/chat');
  },
};

/**
 * The two relationship lookups behind the "View related college programs" and "View colleges
 * offering this program" buttons (migration 0018).
 *
 * Neither is scoped to the student's own recommendation set, and that is deliberate: a student
 * looking at "Software Engineer" is asking what they could study to get there, and answering with
 * only the programs that happen to be in their own top ten would hide the rest of the catalog
 * behind a ranking they did not ask about.
 */
export const catalogLinksApi = {
  programsForCareer(careerId: string): Promise<CareerProgramsResponse> {
    return unwrap(
      httpClient.get<ApiSuccess<CareerProgramsResponse>>(`/student/careers/${careerId}/programs`),
    );
  },

  collegesForProgram(programId: string): Promise<ProgramCollegesResponse> {
    return unwrap(
      httpClient.get<ApiSuccess<ProgramCollegesResponse>>(
        `/student/programs/${programId}/colleges`,
      ),
    );
  },
};
