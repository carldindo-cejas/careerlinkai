import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type {
  AssessmentDeletability,
  AssessmentFormPayload,
  AssessmentListQuery,
  AssessmentRow,
  AssessmentScoring,
  AssessmentType,
  AssignPayload,
  AssignResult,
} from '@/types/assessmentAdmin';
import type { Paginated } from '@/types/class';

/**
 * Assessment management (backend migration 0014) — the taxonomy lookups, the administrator's list,
 * and the four acts on a row: create, edit, archive/restore, assign.
 *
 * The routes are unprefixed rather than living under `/admin`, and that mirrors the API deliberately:
 * the authoring surface is *shared* between an admin and a counselor, differing only in whose
 * assessments are reachable — which is an ownership question answered per record on the server, not a
 * different URL. Mounting the same resource at two paths would be two names for one thing.
 */

/** Strip `undefined` params so the request URL stays clean and the query key stays stable. */
function params(query: AssessmentListQuery): Record<string, string | number> {
  const out: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') {
      out[key] = value as string | number;
    }
  }

  return out;
}

export const assessmentAdminApi = {
  // The taxonomy -----------------------------------------------------------

  /**
   * The 12 types, **each carrying the scoring ids it permits**.
   *
   * One request serves the whole compatibility matrix, which is what lets the scoring multi-select
   * re-filter the moment the type changes rather than waiting on the network.
   */
  listTypes(): Promise<AssessmentType[]> {
    return unwrap(httpClient.get<ApiSuccess<AssessmentType[]>>('/assessment-types'));
  },

  listScorings(): Promise<AssessmentScoring[]> {
    return unwrap(httpClient.get<ApiSuccess<AssessmentScoring[]>>('/assessment-scorings'));
  },

  // The list ---------------------------------------------------------------

  /** Searched, filtered, sorted and paginated **on the server** — see `AssessmentTable`. */
  list(query: AssessmentListQuery = {}): Promise<Paginated<AssessmentRow>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<AssessmentRow>>>('/assessments', {
        params: params(query),
      }),
    );
  },

  // The acts ---------------------------------------------------------------

  /**
   * Create. `category` is fixed to `CUSTOM` here because it is the only category this API can mean:
   * RIASEC and SCCT are curated instruments, seeded rather than authored (§4).
   */
  create(payload: AssessmentFormPayload): Promise<AssessmentRow> {
    return unwrap(
      httpClient.post<ApiSuccess<AssessmentRow>>('/assessment-templates', {
        category: 'CUSTOM',
        ...payload,
      }),
    );
  },

  update(id: string, payload: AssessmentFormPayload): Promise<AssessmentRow> {
    return unwrap(httpClient.patch<ApiSuccess<AssessmentRow>>(`/assessment-templates/${id}`, payload));
  },

  /**
   * Archiving retires an assessment from the assignable list. It deliberately does **not** close
   * assignments already open — closing one expires every attempt still in progress underneath it
   * (§21), and that must stay an explicit act rather than a side effect. The confirmation copy says so.
   */
  archive(id: string): Promise<AssessmentRow> {
    return unwrap(
      httpClient.post<ApiSuccess<AssessmentRow>>(`/assessment-templates/${id}/archive`),
    );
  },

  restore(id: string): Promise<AssessmentRow> {
    return unwrap(
      httpClient.post<ApiSuccess<AssessmentRow>>(`/assessment-templates/${id}/restore`),
    );
  },

  /**
   * Delete — a **soft** delete on the server (§12: `assessment_templates` is on the soft-delete
   * list, and every FK beneath it cascades, so a hard delete would take the authoring history with
   * it). Refused with a 422 and a reason when the assessment has student responses or open
   * assignments; the list's `can_delete` is a snapshot, and this is the authoritative answer.
   */
  remove(id: string): Promise<{ id: string; title: string; deleted_at: string | null }> {
    return unwrap(
      httpClient.delete<ApiSuccess<{ id: string; title: string; deleted_at: string | null }>>(
        `/assessment-templates/${id}`,
      ),
    );
  },

  /**
   * Re-check eligibility at the moment of confirmation.
   *
   * The row already carries this, so the dialog opens without a request. This exists for the case
   * the row cannot cover: a dialog left open while a class started the assessment must say so
   * *before* the delete rather than after it.
   */
  deletability(id: string): Promise<AssessmentDeletability> {
    return unwrap(
      httpClient.get<ApiSuccess<AssessmentDeletability>>(
        `/assessment-templates/${id}/deletability`,
      ),
    );
  },

  /**
   * Assign globally or to chosen classes. Idempotent on the server: a class that already holds this
   * version is skipped, so pressing the button twice tops up rather than duplicating.
   */
  assign(id: string, payload: AssignPayload): Promise<AssignResult> {
    return unwrap(
      httpClient.post<ApiSuccess<AssignResult>>(`/assessment-templates/${id}/assignments`, payload),
    );
  },
};
