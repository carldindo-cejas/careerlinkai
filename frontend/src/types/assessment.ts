import type { Strand } from '@/types/catalog';

/**
 * Assessment types (FULLPLAN §13.4, §13.5, §22, §23).
 *
 * These mirror the API resources exactly — including two things that are absent on purpose:
 *
 *   1. A question carries **no dimension** and an option carries **no score**. A student who
 *      could see that item 14 loads onto "Investigative", and that "Strongly Agree" is worth 5,
 *      would no longer be answering an interest inventory — they would be answering the Holland
 *      Code they would like to have. The server never sends these; the types say so.
 *   2. An answer carries no score either, for the same reason. The score is snapshotted
 *      server-side from the option at answer time (§13.5) and is never client-supplied.
 */

export type AssessmentCategory = 'RIASEC' | 'SCCT' | 'CUSTOM';
export type AttemptStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'SCORED' | 'EXPIRED';
export type AssignmentStatus = 'ACTIVE' | 'CLOSED';

export interface QuestionOption {
  id: string;
  label: string;
  value: string;
  order_number: number;
  // No `score`. See above.
}

export interface AssessmentQuestion {
  id: string;
  question_text: string;
  question_type: 'LIKERT' | 'MULTIPLE_CHOICE' | 'BOOLEAN';
  /** "Investigative" — groups the player into named sections. Never reveals what one item scores. */
  section_label: string | null;
  order_number: number;
  required: boolean;
  options: QuestionOption[];
}

export interface AttemptAnswer {
  question_id: string;
  selected_option_id: string | null;
  answer_text: string | null;
}

export interface AssessmentSummary {
  version_id: string;
  title: string;
  category: AssessmentCategory;
  instructions: string | null;
  duration_minutes: number | null;
}

export interface AssessmentAttempt {
  id: string;
  assignment_id: string;
  status: AttemptStatus;
  started_at: string | null;
  submitted_at: string | null;
  assessment?: AssessmentSummary;
  questions?: AssessmentQuestion[];
  answers?: AttemptAnswer[];
}

export interface AssessmentAssignment {
  id: string;
  class_id: string;
  status: AssignmentStatus;
  deadline: string | null;
  created_at: string | null;
  assessment: {
    version_id: string;
    version_number: number;
    title: string;
    category: AssessmentCategory;
    description: string | null;
    duration_minutes: number | null;
    question_count: number;
  };
  /** Counselor view: how many students have finished. */
  submitted_count?: number;
  /** Student view: my own attempt, if I have started one. Never anyone else's. */
  my_attempt?: {
    id: string;
    status: AttemptStatus;
    submitted_at: string | null;
  } | null;
}

/**
 * One dimension's score. **An absent dimension is not a zero** (§24): it means the student was
 * never measured on it, which is a different and more honest claim, and the UI must not render
 * it as 0.
 */
export interface DimensionScore {
  code: string;
  name: string;
  description: string | null;
  raw_score: string;
  normalized_score: string;
  interpretation: string | null;
}

export interface AssessmentResult {
  attempt_id: string;
  submitted_at: string | null;
  assessment?: { title: string; category: AssessmentCategory };
  result: {
    /** "IAS" for RIASEC. NULL for SCCT, which produces a composite instead (§23). */
    result_code: string | null;
    /**
     * **Display only** (§23, v1.2). Render this string; never parse a number out of it. The
     * dimension breakdown is the source of truth, and Part VII recomputes the composite from
     * those rows rather than from this prose.
     */
    overall_summary: string | null;
    generated_at: string | null;
  } | null;
  dimensions: DimensionScore[];
}

export interface AssessmentTemplate {
  id: string;
  category: AssessmentCategory;
  title: string;
  description: string | null;
  ownership: 'GLOBAL' | 'COUNSELOR_PRIVATE';
  status: string;
  /** A template with no published version cannot be assigned — this is NULL, and the UI says so. */
  assignable_version: {
    id: string;
    version_number: number;
    duration_minutes: number | null;
    question_count: number;
  } | null;
  /** RIASEC/SCCT are permanently false (§5). The UI must not offer AI generation for them. */
  ai_generatable: boolean;
  dimensions?: { code: string; name: string; description: string | null }[];
}

export interface StudentProfile {
  id: string;
  first_name: string;
  last_name: string | null;
  birthdate: string | null;
  gender: string | null;
  grade_level: string | null;
  strand: Strand | null;
  gwa: string | null;
  math_grade: string | null;
  science_grade: string | null;
  english_grade: string | null;
  guardian_name: string | null;
  guardian_contact: string | null;
  /** What Part VII (§27) still needs before it can recommend anything. */
  is_complete_for_recommendations: boolean;
  missing_for_recommendations: string[];
}

export type UpdateProfilePayload = Partial<{
  birthdate: string | null;
  gender: string | null;
  grade_level: string | null;
  strand: Strand | null;
  gwa: number | null;
  math_grade: number | null;
  science_grade: number | null;
  english_grade: number | null;
  guardian_name: string | null;
  guardian_contact: string | null;
}>;
