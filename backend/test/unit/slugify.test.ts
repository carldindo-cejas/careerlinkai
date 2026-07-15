import { describe, expect, it } from 'vitest';

import { baseUsername, parseName, resolveUsername, slugify } from '@/lib/slugify';
import { generateJoinCode, normalizeJoinCode } from '@/modules/classes/join-code';

/**
 * The roster-builder primitives (FULLPLAN §16) and the join-code generator (§13.2, §38).
 *
 * These are pure functions, so they get pinned here rather than through the API — the feature
 * tests then only have to prove the endpoint *uses* them.
 */

describe('slugify', () => {
  it('ASCII-folds accents rather than dropping the letter', () => {
    expect(slugify('José')).toBe('jose');
    expect(slugify('Peña')).toBe('pena');
    expect(slugify('Müller')).toBe('muller');
  });

  it('strips punctuation and spaces', () => {
    expect(slugify("O'Brien")).toBe('obrien');
    expect(slugify('Dela Cruz')).toBe('delacruz');
    expect(slugify('St. John-Smith')).toBe('stjohnsmith');
  });
});

describe('parseName (§16 name-parsing contract)', () => {
  it('takes the first token as the first name and the rest as the last', () => {
    expect(parseName('Juan Dela Cruz')).toEqual({
      name: 'Juan Dela Cruz',
      firstName: 'Juan',
      lastName: 'Dela Cruz',
    });
  });

  it('treats a one-word line as a mononym, with a NULL last name', () => {
    expect(parseName('Madonna')).toEqual({
      name: 'Madonna',
      firstName: 'Madonna',
      lastName: null,
    });
  });

  it('collapses stray whitespace', () => {
    expect(parseName('  Juan   Dela  Cruz  ')).toEqual({
      name: 'Juan Dela Cruz',
      firstName: 'Juan',
      lastName: 'Dela Cruz',
    });
  });
});

describe('baseUsername', () => {
  it('joins first and last with a dot', () => {
    expect(baseUsername(parseName('Juan Dela Cruz'))).toBe('juan.delacruz');
  });

  it('emits just the first name for a mononym — no trailing dot', () => {
    expect(baseUsername(parseName('Madonna'))).toBe('madonna');
  });
});

describe('resolveUsername', () => {
  it('returns the base when it is free', () => {
    expect(resolveUsername('juan.delacruz', new Set())).toBe('juan.delacruz');
  });

  it('suffixes 2, 3, … past collisions', () => {
    const taken = new Set(['juan.delacruz', 'juan.delacruz2']);

    expect(resolveUsername('juan.delacruz', taken)).toBe('juan.delacruz3');
  });

  it('reserves what it hands out, so a batch collides with itself', () => {
    const taken = new Set<string>();

    expect(resolveUsername('juan.delacruz', taken)).toBe('juan.delacruz');
    expect(resolveUsername('juan.delacruz', taken)).toBe('juan.delacruz2');
    expect(resolveUsername('juan.delacruz', taken)).toBe('juan.delacruz3');
  });
});

describe('generateJoinCode', () => {
  it('is four letters, a hyphen, four digits', () => {
    expect(generateJoinCode()).toMatch(/^[A-Z]{4}-[0-9]{4}$/);
  });

  it('never emits I, O, 0 or 1 — the characters a student would misread by hand', () => {
    // 500 codes × 8 characters is a large enough sample that a banned character would show up
    // essentially every run if the alphabet were wrong.
    for (let i = 0; i < 500; i += 1) {
      expect(generateJoinCode()).not.toMatch(/[IO01]/);
    }
  });

  it('does not repeat across a large sample', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateJoinCode()));

    expect(codes.size).toBe(500);
  });
});

describe('normalizeJoinCode', () => {
  it('trims and upper-cases what a student typed', () => {
    expect(normalizeJoinCode('  hvje-5977 ')).toBe('HVJE-5977');
  });

  it('does not repair a lookalike character', () => {
    // Deliberate: repairing `0` → `O` would make the endpoint answer, by which codes it was
    // willing to fix, a question it is built not to answer (§38). A malformed code is simply
    // a code that matches nothing.
    expect(normalizeJoinCode('hvj0-5977')).toBe('HVJ0-5977');
  });
});
