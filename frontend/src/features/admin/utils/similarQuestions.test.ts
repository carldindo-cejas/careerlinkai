import { describe, expect, it } from 'vitest';

import { similarQuestions } from '@/features/admin/utils/similarQuestions';

/**
 * The suggestions the answer form offers as "also answers these" — tested against the rephrasings
 * actually found on the production backlog on 2026-09-11.
 */

const BACKLOG = [
  'Where is Holy Name University located?',
  'HNU located',
  'location of HNU',
  'What colleges in Cebu offer BS Computer Science?',
  'What colleges offer BS Computer Science in Cebu?',
  'What school should I enroll in for a database administrator career?',
  'what school should i enroll for database administrator career',
  'my parents will be angry if I dont pick engineering and I am very stressed',
  'How much is the tuition fee for BS Civil Engineering?',
];

describe('similarQuestions', () => {
  it('groups the three spellings of the Holy Name University question', () => {
    expect(similarQuestions('Where is Holy Name University located?', BACKLOG)).toEqual(
      expect.arrayContaining(['HNU located', 'location of HNU']),
    );
  });

  it('pairs questions that differ only in word order or capitalisation', () => {
    expect(similarQuestions('What colleges in Cebu offer BS Computer Science?', BACKLOG)).toContain(
      'What colleges offer BS Computer Science in Cebu?',
    );
    expect(
      similarQuestions('What school should I enroll in for a database administrator career?', BACKLOG),
    ).toContain('what school should i enroll for database administrator career');
  });

  it('leaves unrelated questions out, and never suggests the question itself', () => {
    const suggestions = similarQuestions('Where is Holy Name University located?', BACKLOG);

    expect(suggestions).not.toContain('Where is Holy Name University located?');
    expect(suggestions).not.toContain('How much is the tuition fee for BS Civil Engineering?');
    expect(suggestions).not.toContain(
      'my parents will be angry if I dont pick engineering and I am very stressed',
    );
  });

  /**
   * Why these are only ever suggestions: lexically, a Bohol question is a near-perfect match for a
   * Cebu one. This test pins that limitation so nobody later "improves" the caller into resolving
   * suggestions automatically.
   */
  it('cannot tell Cebu from Bohol — which is why the form never pre-ticks a suggestion', () => {
    expect(
      similarQuestions('What colleges in Cebu offer BS Computer Science?', [
        'What Colleges offer BS Computer Science in Bohol',
      ]),
    ).toHaveLength(1);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 10 }, (_, i) => `Where is Holy Name University located ${i}`);

    expect(similarQuestions('Where is Holy Name University located?', many, 3)).toHaveLength(3);
  });
});
