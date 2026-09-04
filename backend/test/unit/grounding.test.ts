import { describe, expect, it } from 'vitest';

import {
  answerableFromResults,
  citedIndexes,
  normaliseQuestion,
  offDomainKind,
  offDomainReply,
  parseQaChunk,
  unsupportedClaims,
  validateCitations,
} from '@/lib/grounding';

/**
 * The grounding contract (AiNormalisation Phase 3) — pure, deterministic, tested standalone like
 * the other engines.
 *
 * These functions are the difference between "we told the model not to make things up" and "an
 * invented claim cannot reach a student". Everything here runs on every answer and costs zero
 * neurons, which is the only reason it is affordable to run on every answer.
 */

describe('normaliseQuestion', () => {
  it('treats the same question asked differently as the same question', () => {
    const asked = [
      'How much is tuition?',
      'how much is the tuition',
      'HOW MUCH IS  TUITION!!!',
    ].map(normaliseQuestion);

    expect(asked[0]).toBe('how much is tuition');
    expect(asked[2]).toBe('how much is tuition');
    // Not the same string — "the" is a word, and Gate 1 returns an admin's exact answer, so it
    // matches exactly or it does not match.
    expect(asked[1]).toBe('how much is the tuition');
  });

  it('folds diacritics, so an accented spelling still matches', () => {
    expect(normaliseQuestion('Saint Loüis College')).toBe(normaliseQuestion('saint louis college'));
  });
});

describe('parseQaChunk', () => {
  it('splits a stored pair into its halves', () => {
    expect(parseQaChunk('Q: How much is tuition?\nA: About PHP 25,000 a semester.')).toEqual({
      question: 'How much is tuition?',
      answer: 'About PHP 25,000 a semester.',
    });
  });

  it('returns null for a passage that is not a pair, rather than guessing where the answer starts', () => {
    expect(parseQaChunk('Tuition is about PHP 25,000 a semester.')).toBeNull();
    expect(parseQaChunk('Q: A question with no answer half')).toBeNull();
    expect(parseQaChunk('Q: \nA: ')).toBeNull();
  });
});

describe('validateCitations — cite or refuse', () => {
  it('accepts an answer that points at the passages it was given', () => {
    expect(validateCitations('Nursing takes four years [1], and admits STEM students [2].', 6)).toEqual(
      { ok: true, cited: [1, 2] },
    );
  });

  it('rejects an answer with no marker — it was written from somewhere else', () => {
    expect(validateCitations('Nursing takes four years.', 6)).toEqual({
      ok: false,
      reason: 'NO_CITATION',
    });
  });

  /**
   * The worse of the two failures: a marker a reader can see and cannot check. An answer citing
   * `[7]` when six passages were supplied invented its evidence, not just its claim.
   */
  it('rejects a marker pointing at a passage that was never supplied', () => {
    expect(validateCitations('Tuition is PHP 25,000 [7].', 6)).toEqual({
      ok: false,
      reason: 'CITATION_OUT_OF_RANGE',
    });
  });

  it('deduplicates and preserves first appearance', () => {
    expect(citedIndexes('[2] then [1] then [2] again')).toEqual([2, 1]);
  });
});

describe('unsupportedClaims — the invented figure', () => {
  const sources = [
    'Tuition for BS Nursing at Saint Louis College is approximately PHP 25,000 per semester.',
    'Your strongest career match is Registered Nurse at 87%.',
  ];

  it('passes a figure that appears in a source, however it is written', () => {
    expect(
      unsupportedClaims('Tuition is about PHP 25,000 per semester [1].', sources),
    ).toEqual([]);
    // Same claim, different formatting — the comparison is on digits, not on presentation.
    expect(unsupportedClaims('Tuition is around 25000 pesos [1].', sources)).toEqual([]);
  });

  /**
   * The headline case from the plan: the only thing between a student and an invented tuition fee
   * used to be a prompt rule. Now it is arithmetic on the text.
   */
  it('catches a figure that appears in no source', () => {
    const problems = unsupportedClaims('Tuition is about PHP 40,000 per semester [1].', sources);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ token: '40000', kind: 'NUMBER' });
  });

  it('catches an invented name while accepting one that was supplied', () => {
    expect(unsupportedClaims('Consider Saint Louis College [1].', sources)).toEqual([]);

    const problems = unsupportedClaims('Consider Mapua Malayan Colleges [1].', sources);

    expect(problems.map((problem) => problem.token)).toContain('Mapua');
  });

  it('accepts a claim grounded in computed results rather than a document', () => {
    // 87% is arithmetic (§26), not retrieval — rejecting it would reject the truest sentence in
    // the answer, which is why the student's own results are part of `sources`.
    expect(unsupportedClaims('Your top match is Registered Nurse at 87% [2].', sources)).toEqual(
      [],
    );
  });

  it('does not treat ordinary prose numbers or citation markers as claims', () => {
    expect(unsupportedClaims('You have 3 strong matches [1]. Two of them are health careers [2].', sources)).toEqual([]);
  });
});

describe('unsupportedClaims — refusing the invention without refusing the paraphrase', () => {
  /**
   * All four cases below are drawn from one production run of **Explain more** across twenty
   * recommendations (2026-09-05), in which eight explanations were refused and the student was
   * shown the deterministic reason instead. Three of the four refusals were the assistant saying
   * something true in slightly different words; the fourth was a fabricated percentage.
   *
   * They are pinned together on purpose. The fix for the first three is only correct if it leaves
   * the fourth refused, and a test file that asserted the loosening without the catch would be
   * evidence for exactly the wrong thing.
   */
  const sources = [
    'Career: Civil Engineer. Designs and supervises infrastructure projects.',
    'Your Realistic interest score (100%) aligns with Civil Engineer.',
    '88.1',
  ];

  it('accepts the plural of a name the sources give in the singular', () => {
    // Six of the eight production refusals were this exact word: the passage says "Civil
    // Engineer", the model wrote "Civil Engineers", and the substring test called it unsourced.
    expect(unsupportedClaims('Civil Engineers design infrastructure [1].', sources)).toEqual([]);
  });

  it('accepts a figure written with different precision', () => {
    // The sources say "100%"; the model wrote "100.0%". One value, two spellings.
    expect(unsupportedClaims('Your Realistic score is 100.0% [2].', sources)).toEqual([]);
  });

  it('still refuses a figure the sources do not hold', () => {
    // The real refusal from that run. No recommendation in the database scores 97.3 — the highest
    // is 93.4 — so this is the model inventing a number, and it must keep failing.
    const problems = unsupportedClaims('You matched at 97.3% [1].', sources);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ token: '97.3', kind: 'NUMBER' });
  });

  it('does not let the plural fold invent a source', () => {
    // "Nurses" must not pass merely because it can be folded — nothing here mentions a nurse.
    const problems = unsupportedClaims('Consider becoming one of the Nurses [1].', sources);

    expect(problems.map((problem) => problem.token)).toContain('Nurses');
  });
});

describe('offDomainKind — what this assistant declines', () => {
  it('declines schoolwork', () => {
    expect(offDomainKind('solve this equation for x please')).toBe('HOMEWORK');
    expect(offDomainKind('write me an essay about rizal')).toBe('HOMEWORK');
    expect(offDomainKind('can you do my homework')).toBe('HOMEWORK');
  });

  /**
   * The branch that matters most. A student bringing this to the only thing on screen that talks
   * back must be pointed at a person, not met with a refusal — so it is classified separately and
   * answered differently.
   */
  it('routes a personal or distressing message to a person, warmly', () => {
    expect(offDomainKind('i feel so hopeless about everything')).toBe('PERSONAL');
    expect(offDomainReply('PERSONAL')).toMatch(/guidance counselor/i);
    expect(offDomainReply('PERSONAL')).toMatch(/trust/i);
    // Never a bare "I can't help with that".
    expect(offDomainReply('PERSONAL').length).toBeGreaterThan(120);
  });

  it('leaves ordinary guidance questions alone', () => {
    expect(offDomainKind('why is nursing my top match?')).toBeNull();
    expect(offDomainKind('how much is tuition at that college?')).toBeNull();
    expect(offDomainKind('what strand should I take for BSCS?')).toBeNull();
  });

  /**
   * Added 2026-09-05 from a production session. The first cut of these patterns caught *crisis*
   * vocabulary and missed the register students in career guidance actually use — this exact
   * message fell through to retrieval, failed the grounding contract, and answered a frightened
   * student with "I don't have anything in the school's guidance materials that answers that."
   *
   * Family pressure and fear about the future are the ordinary emotional content of this product,
   * not the exceptional case.
   */
  it('routes ordinary student distress, not only crisis language', () => {
    expect(
      offDomainKind('my parents will be angry if I dont pick engineering and I am very stressed'),
    ).toBe('PERSONAL');
    expect(offDomainKind('i am so overwhelmed by all of this')).toBe('PERSONAL');
    expect(offDomainKind('my parents are forcing me to take nursing')).toBe('PERSONAL');
    expect(offDomainKind('my mom wont let me take fine arts')).toBe('PERSONAL');
    expect(offDomainKind('takot ako na hindi ako makapasa')).toBe('PERSONAL');
  });

  /**
   * The other half of that change, and the one that keeps it honest.
   *
   * Every word above also appears in questions this assistant exists to answer. The guard is
   * anchored on the student describing *themselves*: "I am stressed" is a person asking for help,
   * "is nursing stressful?" is a career question, and deflecting the second to a counsellor would
   * be a worse product sold as a safer one. A parent merely *wanting* something is likewise a
   * question with family context, not a crisis.
   */
  it('does not deflect a career question that merely contains a feeling word', () => {
    expect(offDomainKind('is nursing a stressful job?')).toBeNull();
    expect(offDomainKind('are engineers usually stressed at work?')).toBeNull();
    expect(offDomainKind('my parents want me to take nursing, is it a good match?')).toBeNull();
    expect(offDomainKind('which careers have the least pressure?')).toBeNull();
  });
});

describe('answerableFromResults — narrowing the zero-retrieval path (D7)', () => {
  const context = 'Registered Nurse — 87%. Medical Technologist — 81%. BS Nursing at Saint Louis College.';

  it('allows a question about the results themselves', () => {
    expect(answerableFromResults('which of my top three pays best?', context)).toBe(true);
    expect(answerableFromResults('why is this my best match?', context)).toBe(true);
  });

  it('allows a question naming something in the student’s own set', () => {
    expect(answerableFromResults('tell me more about Medical Technologist', context)).toBe(true);
  });

  /**
   * The case this exists for. With nothing retrieved, a tuition question has no grounding at all —
   * and answering it anyway is where the invented figure comes from.
   */
  it('refuses a question the results cannot possibly answer', () => {
    expect(answerableFromResults('how much is the dormitory fee?', context)).toBe(false);
    expect(answerableFromResults('when is the entrance exam?', context)).toBe(false);
  });
});
