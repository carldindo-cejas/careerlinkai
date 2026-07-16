import { describe, expect, it } from 'vitest';

import { parseGenerationOutput } from '@/modules/ai/assessment-generation-service';

/**
 * The §34 output validator — the guard between a model's output and the database. Tested
 * against hand-written malformed payloads because this is the one input in the system that
 * is *expected* to be malformed sometimes: a model's compliance with "output strict JSON"
 * is a request, not a guarantee (§32), and the validator is the enforcement.
 */

const CODES = new Set(['TM', 'FO']);

function question(overrides: Record<string, unknown> = {}) {
  return {
    question_text: 'I plan my study sessions in advance.',
    question_type: 'LIKERT',
    options: [
      { label: 'Agree', value: 'agree', score: 3 },
      { label: 'Disagree', value: 'disagree', score: 1 },
    ],
    dimension_code: 'TM',
    ...overrides,
  };
}

describe('parseGenerationOutput (§34)', () => {
  it('parses a well-formed payload, keeping the mapping onto a known dimension code', () => {
    const output = parseGenerationOutput(
      JSON.stringify({ questions: [question()] }),
      50,
      CODES,
    );

    expect(output).not.toBeNull();
    expect(output!.questions).toHaveLength(1);
    expect(output!.questions[0]).toMatchObject({
      questionText: 'I plan my study sessions in advance.',
      questionType: 'LIKERT',
      dimensionCode: 'TM',
    });
    expect(output!.questions[0]!.options).toHaveLength(2);
  });

  it('strips the ```json fences chat models wrap their output in', () => {
    const fenced = '```json\n' + JSON.stringify({ questions: [question()] }) + '\n```';

    expect(parseGenerationOutput(fenced, 50, CODES)).not.toBeNull();
  });

  it('rejects malformed JSON outright', () => {
    expect(parseGenerationOutput('Sure! Here are your questions: 1. …', 50, CODES)).toBeNull();
    expect(parseGenerationOutput('{"questions": [', 50, CODES)).toBeNull();
  });

  it('rejects a payload whose questions key is missing or not an array', () => {
    expect(parseGenerationOutput('{"items": []}', 50, CODES)).toBeNull();
    expect(parseGenerationOutput('{"questions": "sixty of them"}', 50, CODES)).toBeNull();
  });

  it('truncates past the question cap rather than failing the whole run', () => {
    const many = Array.from({ length: 60 }, () => question());
    const output = parseGenerationOutput(JSON.stringify({ questions: many }), 50, CODES);

    expect(output!.questions).toHaveLength(50);
  });

  it('drops a question with fewer than 2 valid options — §34: every question needs at least 2', () => {
    const output = parseGenerationOutput(
      JSON.stringify({
        questions: [
          question({ options: [{ label: 'Only one', value: 'one', score: 1 }] }),
          question(),
        ],
      }),
      50,
      CODES,
    );

    expect(output!.questions).toHaveLength(1);
  });

  it('drops an option with a non-numeric score, and the question with it if <2 survive', () => {
    const output = parseGenerationOutput(
      JSON.stringify({
        questions: [
          question({
            options: [
              { label: 'Agree', value: 'agree', score: 'five' },
              { label: 'Disagree', value: 'disagree', score: 1 },
            ],
          }),
        ],
      }),
      50,
      CODES,
    );

    expect(output).toBeNull(); // the only question died with its options
  });

  it('drops a question with an unknown question_type', () => {
    const output = parseGenerationOutput(
      JSON.stringify({ questions: [question({ question_type: 'FREE_TEXT' }), question()] }),
      50,
      CODES,
    );

    expect(output!.questions).toHaveLength(1);
  });

  it('drops a dimension_code the creator never defined — an invented code must not invent a dimension', () => {
    const output = parseGenerationOutput(
      JSON.stringify({ questions: [question({ dimension_code: 'GRIT' })] }),
      50,
      CODES,
    );

    expect(output!.questions[0]!.dimensionCode).toBeNull();
  });

  it('returns null when zero questions survive — a run that drafted nothing failed, whatever the JSON looked like', () => {
    const output = parseGenerationOutput(
      JSON.stringify({ questions: [question({ question_text: '' })] }),
      50,
      CODES,
    );

    expect(output).toBeNull();
  });

  it('keeps well-formed suggested_dimensions and ignores junk entries (§31 Mode A)', () => {
    const output = parseGenerationOutput(
      JSON.stringify({
        questions: [question()],
        suggested_dimensions: [
          { name: 'Time Management', description: 'Planning and pacing.' },
          { description: 'nameless' },
          'just a string',
        ],
      }),
      50,
      CODES,
    );

    expect(output!.suggestedDimensions).toEqual([
      { name: 'Time Management', description: 'Planning and pacing.' },
    ]);
  });

  it('falls back to the label when an option value is missing', () => {
    const output = parseGenerationOutput(
      JSON.stringify({
        questions: [
          question({
            options: [
              { label: 'Agree', score: 3 },
              { label: 'Disagree', score: 1 },
            ],
          }),
        ],
      }),
      50,
      CODES,
    );

    expect(output!.questions[0]!.options.map((option) => option.value)).toEqual([
      'Agree',
      'Disagree',
    ]);
  });
});
