import type {
  AssessmentDimension,
  AssessmentQuestion,
  AssessmentTemplate,
  AssessmentVersion,
  QuestionOption,
  StudentProfile,
} from '@/db/schema';
import type { ScoredDimension } from '@/lib/scoring';
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

export function serializeTemplate(
  template: AssessmentTemplate,
  assignableVersion: AssessmentVersion | undefined,
  questionCount: number,
  dimensions?: AssessmentDimension[],
) {
  return {
    id: template.id,
    category: template.category,
    title: template.title,
    description: template.description,
    ownership: template.ownership,
    status: template.status,
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
