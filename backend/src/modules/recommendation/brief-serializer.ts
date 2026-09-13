import type { StudentBrief } from '@/modules/recommendation/student-brief-service';

/**
 * The Student Brief on the wire (`GET /student/brief`, AI-COVERAGE-PLAN.md Phase 4).
 *
 * The chat panel fetches it when a student signs in, so it opens already knowing what the student
 * has done — a UX preload, not a model preload: the model still receives the brief on each turn.
 * The suggested questions are chosen so that every one of them is answered by Gate 1 or Gate 2, at
 * zero neurons — the chips steer the most common first questions to the free gates.
 */
export function serializeBrief(brief: StudentBrief): Record<string, unknown> {
  return {
    profile: {
      grade_level: brief.profile.gradeLevel,
      strand: brief.profile.strand,
      grades: brief.profile.grades,
      average: brief.profile.average,
    },
    riasec: {
      complete: brief.riasec.complete,
      holland_code: brief.riasec.hollandCode,
      dimensions: brief.riasec.dimensions,
    },
    scct: {
      complete: brief.scct.complete,
      confidence_index: brief.scct.confidenceIndex,
      band: brief.scct.band,
      dimensions: brief.scct.dimensions,
    },
    has_recommendations: brief.careers.length > 0 || brief.programs.length > 0,
    suggestions: suggestedQuestions(brief),
  };
}

export function suggestedQuestions(brief: StudentBrief): string[] {
  const topCareer = brief.careers[0];
  const topProgram = brief.programs[0];

  if (topCareer !== undefined && topProgram !== undefined) {
    return [
      `Why ${topCareer.title}?`,
      `Where can I study ${topProgram.title}?`,
      'What are my top 5 careers?',
      'Which of my top careers pays the best?',
    ];
  }

  if (brief.riasec.complete) {
    return [
      'What is my Holland code?',
      'Show my RIASEC scores',
      'What can you do?',
      'What colleges are in Bohol?',
    ];
  }

  return [
    'What can you do?',
    'What colleges are in Bohol?',
    'Which colleges offer BS Information Technology?',
    'What careers come after BS Accountancy?',
  ];
}
