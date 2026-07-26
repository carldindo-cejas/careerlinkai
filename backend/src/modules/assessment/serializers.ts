import type {
  AssessmentDimension,
  AssessmentQuestion,
  AssessmentScoring,
  AssessmentTemplate,
  AssessmentType,
  AssessmentVersion,
  QuestionOption,
  StudentProfile,
} from '@/db/schema';
import type { ScoredDimension } from '@/lib/scoring';
import type { AssessmentListRow } from '@/modules/assessment/assessment-admin-service';
import type {
  AssignmentView,
  AttemptWithContent,
  ResultView,
} from '@/modules/assessment/assessment-attempt-service';

/**
 * The assessment module's allow-lists (FULLPLAN §37, §13.5).
 *
 * Every serializer here is an **allow-list**, never a deny-list that strips fields on the way
 * out. That is the same rule the Class module follows, and for the same reason: an allow-list
 * cannot leak a column somebody adds next year, and a deny-list can. In this module the stakes
 * are higher than usual — see `serializeQuestion`.
 */

/**
 * **The player payload, and what it deliberately omits.**
 *
 * A question carries **no dimension**, and an option carries **no score**. This is not an
 * oversight and it is not something a future "helpful transparency" change should add back: a
 * student who can see that item 14 loads onto Investigative, and that "Strongly Agree" is worth
 * 5, stops answering an interest inventory and starts answering the Holland Code they would like
 * to have. The instrument would then measure what the student wants the software to conclude —
 * and every recommendation downstream rests on that number.
 *
 * `section_label` ("Investigative") **is** sent, as a progress heading. That is a deliberate,
 * limited disclosure: it groups sixty items into legible chunks without revealing what any single
 * one scores.
 *
 * `AssessmentPlayerPage.test.tsx` asserts this from the other side of the wire.
 */
export function serializeQuestion(question: AssessmentQuestion & { options: QuestionOption[] }) {
  return {
    id: question.id,
    question_text: question.questionText,
    question_type: question.questionType,
    section_label: question.sectionLabel,
    order_number: question.orderNumber,
    required: question.required,
    options: question.options.map(serializeOption),
  };
}

/** No `score`. See `serializeQuestion`. */
export function serializeOption(option: QuestionOption) {
  return {
    id: option.id,
    label: option.label,
    value: option.value,
    order_number: option.orderNumber,
  };
}

/** No `score` here either — the answer's score is a server-side snapshot the student never sees. */
export function serializeAnswer(answer: {
  questionId: string;
  selectedOptionId: string | null;
  answerText: string | null;
}) {
  return {
    question_id: answer.questionId,
    selected_option_id: answer.selectedOptionId,
    answer_text: answer.answerText,
  };
}

export function serializeAttempt(view: AttemptWithContent) {
  return {
    id: view.attempt.id,
    assignment_id: view.attempt.assignmentId,
    status: view.attempt.status,
    started_at: view.attempt.startedAt,
    submitted_at: view.attempt.submittedAt,
    assessment: {
      version_id: view.version.id,
      title: view.template.title,
      category: view.template.category,
      instructions: view.version.instructions,
      duration_minutes: view.version.durationMinutes,
    },
    questions: view.questions.map(serializeQuestion),
    answers: view.answers.map(serializeAnswer),
  };
}

export function serializeAssignment(view: AssignmentView) {
  return {
    id: view.assignment.id,
    class_id: view.assignment.classId,
    status: view.assignment.status,
    /** Migration 0014 — the act that wrote this row, so a class can see "assigned to everyone". */
    scope: view.assignment.scope,
    deadline: view.assignment.deadline,
    created_at: view.assignment.createdAt,
    assessment: {
      version_id: view.version.id,
      version_number: view.version.versionNumber,
      title: view.template.title,
      category: view.template.category,
      description: view.template.description,
      duration_minutes: view.version.durationMinutes,
      question_count: view.questionCount,
    },
    // The counselor sees a count; the student sees their own attempt. Neither sees the other's.
    ...(view.submittedCount !== undefined ? { submitted_count: view.submittedCount } : {}),
    ...(view.myAttempt !== undefined
      ? {
          my_attempt:
            view.myAttempt === null
              ? null
              : {
                  id: view.myAttempt.id,
                  status: view.myAttempt.status,
                  submitted_at: view.myAttempt.submittedAt,
                },
        }
      : {}),
  };
}

/**
 * One dimension's score.
 *
 * **An absent dimension is not a zero** (§24) — and the honest way to serialize that is simply
 * not to emit a row for it. Nothing here fills a gap with a 0.00, because a 0.00 is a claim that
 * the student was measured and scored nothing, which is a different and false statement.
 */
export function serializeDimensionScore(
  scored: ScoredDimension,
  dimension: AssessmentDimension | undefined,
) {
  return {
    code: scored.code,
    name: dimension?.name ?? scored.code,
    description: dimension?.description ?? null,
    raw_score: decimal(scored.rawScore),
    normalized_score: decimal(scored.normalizedScore),
    interpretation: scored.interpretation,
  };
}

export function serializeResult(view: ResultView, dimensions: AssessmentDimension[]) {
  const byId = new Map(dimensions.map((dimension) => [dimension.id, dimension]));

  return {
    attempt_id: view.attempt.id,
    submitted_at: view.attempt.submittedAt,
    assessment: {
      title: view.template.title,
      category: view.template.category,
    },
    result:
      view.result === undefined
        ? null
        : {
            result_code: view.result.resultCode,
            /** **Display only** (§23) — Part VII recomputes the index, never parses this. */
            overall_summary: view.result.overallSummary,
            generated_at: view.result.generatedAt,
          },
    dimensions: view.dimensions.map((scored) =>
      serializeDimensionScore(scored, byId.get(scored.dimensionId)),
    ),
  };
}

// --- The taxonomy (migration 0014) ------------------------------------------------------------

/**
 * One assessment type, **with the ids of every scoring method it permits**.
 *
 * `allowed_scoring_ids` is the client's whole copy of the compatibility matrix, and shipping it
 * inside the type list is the point: the scoring multi-select has to re-filter the instant the type
 * changes, and a request per change would put a round trip inside a keystroke. It is ids rather
 * than whole rows because the scoring lookup is fetched once alongside this and joined in the UI —
 * sending fifteen nested copies of the same rows would be twelve times the payload for no
 * information.
 */
export function serializeAssessmentType(type: AssessmentType, allowedScoringIds: string[]) {
  return {
    id: type.id,
    code: type.code,
    name: type.name,
    description: type.description,
    order_number: type.orderNumber,
    allowed_scoring_ids: allowedScoringIds,
  };
}

export function serializeAssessmentScoring(scoring: AssessmentScoring) {
  return {
    id: scoring.id,
    code: scoring.code,
    name: scoring.name,
    description: scoring.description,
    order_number: scoring.orderNumber,
  };
}

/**
 * One row of the administrator's assessment table.
 *
 * Everything the table renders is already resolved here — the type, the scoring methods, every
 * version, whether one of them is published, how it is assigned. That is deliberate and is the
 * counterpart to `AssessmentAdminService`'s grouped lookups: a row that made the client fetch its
 * own versions would put the N+1 back on the other side of the wire.
 *
 * **`assignment.scope` is `null` for "not assigned", not `'CLASS'` with a zero count.** The three
 * states the column shows are genuinely three, and collapsing the third into a count of zero is how
 * a table ends up saying "Specific classes (0)".
 */
export function serializeAssessmentRow(row: AssessmentListRow) {
  return {
    id: row.template.id,
    title: row.template.title,
    description: row.template.description,
    category: row.template.category,
    ownership: row.template.ownership,
    /** `ARCHIVED` | `ACTIVE` | `DRAFT` — the stored column, for the Archive/Restore action. */
    status: row.template.status,
    /**
     * The **derived** status the Status column shows: is anything actually publishable. An archived
     * assessment reports `is_archived` separately, because "archived" and "has a published version"
     * are independent facts and one badge cannot carry both.
     */
    is_published: row.publishedVersion !== undefined,
    is_archived: row.template.status === 'ARCHIVED',
    type:
      row.type === null
        ? null
        : { id: row.type.id, code: row.type.code, name: row.type.name },
    scorings: row.scorings.map((scoring) => ({
      id: scoring.id,
      code: scoring.code,
      name: scoring.name,
    })),
    versions: row.versions.map((version) => ({
      id: version.id,
      version_number: version.versionNumber,
      status: version.status,
    })),
    published_version:
      row.publishedVersion === undefined
        ? null
        : {
            id: row.publishedVersion.id,
            version_number: row.publishedVersion.versionNumber,
            duration_minutes: row.publishedVersion.durationMinutes,
            question_count: row.questionCount,
          },
    assignment: {
      scope: row.assignment.scope,
      class_count: row.assignment.classCount,
    },
    /** Permanently false for RIASEC and SCCT (§5) — the UI mirrors the rule it cannot enforce. */
    ai_generatable: row.template.category === 'CUSTOM',
    created_at: row.template.createdAt,
    updated_at: row.template.updatedAt,
  };
}

export function serializeTemplate(
  template: AssessmentTemplate,
  assignableVersion: AssessmentVersion | undefined,
  questionCount: number,
  dimensions?: AssessmentDimension[],
  /** Migration 0014 — resolved by the caller, which already batched them for the whole list. */
  type?: AssessmentType | null,
  scorings?: AssessmentScoring[],
) {
  return {
    id: template.id,
    category: template.category,
    title: template.title,
    description: template.description,
    ownership: template.ownership,
    status: template.status,
    assessment_type_id: template.assessmentTypeId,
    type:
      type === undefined || type === null
        ? null
        : { id: type.id, code: type.code, name: type.name },
    scorings: (scorings ?? []).map((scoring) => ({
      id: scoring.id,
      code: scoring.code,
      name: scoring.name,
    })),
    /** NULL when nothing is publishable yet — the UI says so rather than offering a dead button. */
    assignable_version:
      assignableVersion === undefined
        ? null
        : {
            id: assignableVersion.id,
            version_number: assignableVersion.versionNumber,
            duration_minutes: assignableVersion.durationMinutes,
            question_count: questionCount,
          },
    /**
     * **Permanently false for RIASEC and SCCT** (§5). The UI reads this to decide whether to
     * offer AI generation at all — but the UI is not the enforcement. `policies/assessment.ts`
     * refuses the act itself, checking the category *before* ownership so that not even an admin
     * can pass. §6 requires exactly that: "rejected by the backend, not just hidden by the UI".
     */
    ai_generatable: template.category === 'CUSTOM',
    ...(dimensions !== undefined
      ? {
          dimensions: dimensions.map((dimension) => ({
            code: dimension.code,
            name: dimension.name,
            description: dimension.description,
          })),
        }
      : {}),
  };
}

/**
 * The §27 inputs a student profile still needs (`docs/api`).
 *
 * `strand` and `gwa` are the two the engine cannot do without — strand gates the alignment
 * component and GWA drives both academic fit and eligibility. The other fields are informational.
 */
export function serializeStudentProfile(profile: StudentProfile) {
  const missing: string[] = [];

  if (profile.strand === null) {
    missing.push('strand');
  }

  if (profile.gwa === null) {
    missing.push('gwa');
  }

  return {
    id: profile.id,
    first_name: profile.firstName,
    last_name: profile.lastName,
    birthdate: profile.birthdate,
    gender: profile.gender,
    grade_level: profile.gradeLevel,
    strand: profile.strand,
    gwa: decimal(profile.gwa),
    math_grade: decimal(profile.mathGrade),
    science_grade: decimal(profile.scienceGrade),
    english_grade: decimal(profile.englishGrade),
    guardian_name: profile.guardianName,
    guardian_contact: profile.guardianContact,
    is_complete_for_recommendations: missing.length === 0,
    missing_for_recommendations: missing,
  };
}

/**
 * REAL in SQLite, a **string** on the wire — the shape the frontend's types already pin
 * (`gwa: string | null`, `raw_score: string`), inherited from the Laravel contract's
 * `DECIMAL(5,2)` serialization. Two decimals, so `88` renders as `"88.00"` rather than `"88"`
 * and a grade never arrives looking like a different precision than it was stored at.
 */
function decimal(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}

// --- The author's view (Phase 5b — builder + §31 review) --------------------------------------

/**
 * The review payload — and the one place a question crosses the wire **with** its option
 * scores and its dimension mappings. This is the exact information `serializeQuestion`
 * exists to withhold from a student, disclosed on purpose to the person §25 asks to confirm
 * it: a reviewer who cannot see what a question measures and what each answer scores cannot
 * meaningfully confirm anything. The route group's staff gate is what keeps these two
 * serializers pointed at different audiences.
 */
export function serializeAuthorQuestion(
  question: AssessmentQuestion,
  options: QuestionOption[],
  mappings: {
    id: string;
    dimensionCode: string;
    dimensionName: string;
    weight: number;
    confirmedAt: string | null;
  }[],
) {
  return {
    id: question.id,
    question_text: question.questionText,
    question_type: question.questionType,
    section_label: question.sectionLabel,
    order_number: question.orderNumber,
    required: question.required,
    source: question.source,
    source_ai_request_id: question.sourceAiRequestId,
    options: options.map((option) => ({
      id: option.id,
      label: option.label,
      value: option.value,
      score: option.score,
      order_number: option.orderNumber,
    })),
    dimensions: mappings.map((mapping) => ({
      mapping_id: mapping.id,
      code: mapping.dimensionCode,
      name: mapping.dimensionName,
      weight: mapping.weight,
      confirmed: mapping.confirmedAt !== null,
      confirmed_at: mapping.confirmedAt,
    })),
  };
}

export function serializeVersionSummary(version: AssessmentVersion) {
  return {
    id: version.id,
    version_number: version.versionNumber,
    status: version.status,
    instructions: version.instructions,
    duration_minutes: version.durationMinutes,
    scoring_algorithm: version.scoringConfig.algorithm,
    created_at: version.createdAt,
  };
}
