import type { RetrievedChunk } from '@/modules/ai/retrieval-service';

/**
 * Turning retrieved chunks into the line a student reads under an answer — *"Based on: 2026
 * Admissions Handbook"* (AiNormalisation Phase 3).
 *
 * Shared by both pipelines because it is one rule, not two: **name what the answer actually used**.
 * Naming a passage the model was shown but never cited would be a worse lie than naming none — the
 * student would go and check it, and find nothing.
 *
 * Titles rather than chunk ids, deduplicated, in citation order. Several chunks routinely come from
 * one document, and "Based on: Handbook, Handbook, Handbook" tells a reader nothing they did not
 * already know.
 */

/** Every document behind these chunks, in order, deduplicated. */
export function sourceTitles(retrieved: RetrievedChunk[]): string[] {
  return [...new Set(retrieved.map(({ documentTitle }) => documentTitle))].filter(
    (title) => title.trim() !== '',
  );
}

/**
 * Only the documents the answer cited, in the order it cited them.
 *
 * `cited` holds 1-based marker numbers as they appeared in the text, so an out-of-range marker
 * simply contributes nothing — this runs *after* `validateCitations`, and defending twice is
 * cheaper than assuming the order of two checks will never change.
 */
export function sourceTitlesFor(retrieved: RetrievedChunk[], cited: number[]): string[] {
  return sourceTitles(
    cited.flatMap((index) => {
      const chunk = retrieved[index - 1];

      return chunk === undefined ? [] : [chunk];
    }),
  );
}
