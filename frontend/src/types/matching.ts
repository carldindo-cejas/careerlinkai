import type { Strand } from '@/types/catalog';
import type { ScoringFormula } from '@/types/formula';

/**
 * The admin Matching page (backend 2026-09-22): are students' recommendation sets still what the
 * system would say today, recompute the ones that are not, and preview a hypothetical student.
 */

export interface RecommendationFreshness {
  /** The last change to anything the match scores against; null if nothing has changed. */
  inputs_changed_at: string | null;
  students_with_sets: number;
  /** Sets generated before `inputs_changed_at`. */
  stale_sets: number;
}

export interface RecomputePage {
  regenerated: number;
  failed: number;
  remaining: number;
}

export type RiasecScores = Record<'R' | 'I' | 'A' | 'S' | 'E' | 'C', number>;

export interface PreviewInput {
  riasec: RiasecScores;
  career_confidence: number;
  academic_average: number | null;
  strand: Strand | null;
  /** Score against an unsaved draft instead of the saved formula. */
  formula?: ScoringFormula;
}

export interface PreviewCareer {
  id: string;
  title: string;
  typical_riasec_code: string | null;
  match_score: number;
  reason: string;
  components: Record<string, number>;
}

export interface PreviewProgram {
  id: string;
  name: string;
  college_name: string;
  match_score: number;
  reason: string;
  components: Record<string, number>;
  /** What the program leads to — the careers its score was built from. */
  careers: string[];
}

export interface PreviewResult {
  careers: PreviewCareer[];
  programs: PreviewProgram[];
}
