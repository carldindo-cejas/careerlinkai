import { describe, expect, it } from 'vitest';

import {
  CHARS_PER_TOKEN,
  chunkText,
  cleanText,
  estimateTokens,
  MAX_CHUNK_TOKENS,
  OVERLAP_TOKENS,
} from '@/lib/chunker';

/**
 * The §33 chunker — pure, deterministic, and tested standalone like the other engines. The
 * ceiling matters twice over: an oversized chunk embeds badly, and downstream every chunk
 * row must fit D1's bound-parameter budget alongside its siblings.
 */

describe('cleanText', () => {
  it('normalizes line endings and collapses whitespace runs', () => {
    expect(cleanText('a\r\nb\rc')).toBe('a\nb\nc');
    expect(cleanText('too   many\t\tspaces')).toBe('too many spaces');
  });

  it('drops page-number furniture but keeps real numbered content', () => {
    expect(cleanText('Real sentence.\n12\nPage 3 of 10\n- 7 -\nAnother sentence.')).toBe(
      'Real sentence.\nAnother sentence.',
    );
    // A line that *contains* a number is content, not furniture.
    expect(cleanText('Chapter 12 covers RIASEC.')).toBe('Chapter 12 covers RIASEC.');
  });

  it('collapses three or more blank lines to one blank line', () => {
    expect(cleanText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('chunkText', () => {
  it('returns nothing for empty text and one chunk for short text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);

    const chunks = chunkText('A single short paragraph about careers.');

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkNumber).toBe(1);
  });

  it('never exceeds the §33 ceiling of 800 tokens per chunk', () => {
    const text = Array.from(
      { length: 200 },
      (_, i) => `Sentence number ${i} talks about interests, careers and study habits at length.`,
    ).join(' ');

    for (const chunk of chunkText(text)) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.content));
    }
  });

  it('numbers chunks sequentially from 1 — the unique index depends on it', () => {
    const text = 'word '.repeat(3000);
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.chunkNumber)).toEqual(
      chunks.map((_, index) => index + 1),
    );
  });

  it('overlaps adjacent chunks, so a fact on a boundary is whole in at least one of them', () => {
    const text = Array.from({ length: 300 }, (_, i) => `Fact ${i} is about careers.`).join(' ');
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);

    for (let i = 1; i < chunks.length; i += 1) {
      // The head of chunk N must appear inside chunk N-1: that shared text IS the overlap.
      const head = chunks[i]!.content.slice(0, Math.floor((OVERLAP_TOKENS * CHARS_PER_TOKEN) / 3));

      expect(chunks[i - 1]!.content).toContain(head);
    }
  });

  it('covers the whole text — nothing between the first and last chunk is lost', () => {
    const text = Array.from({ length: 300 }, (_, i) => `Passage ${i} about study skills.`).join(' ');
    const chunks = chunkText(text);

    // Every 200-char probe of the source must be present in some chunk.
    for (let at = 0; at < text.length - 200; at += 997) {
      const probe = text.slice(at, at + 200);

      expect(chunks.some((chunk) => chunk.content.includes(probe))).toBe(true);
    }
  });

  it('is deterministic — the same text always chunks identically (§43 idempotency)', () => {
    const text = 'The quick brown fox studies career guidance. '.repeat(400);

    expect(chunkText(text)).toEqual(chunkText(text));
  });
});
