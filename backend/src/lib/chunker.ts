/**
 * Text cleaning and chunking for knowledge ingestion (FULLPLAN §33) — pure string work, no
 * I/O, no bindings, unit-tested standalone like `lib/scoring.ts` and `lib/recommendation.ts`.
 *
 * Chunking runs inside a queue consumer, which on the Free plan has the same 10 ms CPU budget
 * as a request handler (§42 v1.5). String slicing over the ≤500k-char cap fits comfortably;
 * anything heavier (the PDF/DOCX parsing itself) happens in the admin's browser before the
 * text ever reaches the Worker (§33 v1.5).
 */

/**
 * §33: 300–800 tokens per chunk, 50–100 tokens of overlap. Tokens are estimated at ~4
 * characters each — the standard heuristic for English text, and precision does not matter
 * here: the bounds exist to keep a chunk small enough to embed well and large enough to
 * carry context, not to bill anyone.
 */
export const CHARS_PER_TOKEN = 4;
export const MIN_CHUNK_TOKENS = 300;
export const MAX_CHUNK_TOKENS = 800;
export const OVERLAP_TOKENS = 75;

const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

export interface TextChunk {
  chunkNumber: number;
  content: string;
  tokenCount: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Normalize browser-extracted text (§33's "clean" step): unify line endings, collapse runs
 * of blank lines and intra-line whitespace, and drop lines that are nothing but a page
 * number — the classic header/footer residue a PDF extractor leaves behind.
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ') // non-breaking spaces (PDF extractors love them)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    // "Page 12 of 34", "12", "- 12 -" — furniture, not knowledge.
    .filter((line) => !/^(page\s+)?[-–—\s]*\d+[-–—\s]*(of\s+\d+)?$/i.test(line) || line === '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split cleaned text into §33-sized chunks with overlap.
 *
 * Boundaries prefer a paragraph break, then a sentence end, inside the tail of the window —
 * an embedding of half a sentence retrieves worse than one of a whole thought. Adjacent
 * chunks share ~75 tokens of overlap so a fact straddling a boundary is wholly inside at
 * least one chunk. Deterministic: the same text always chunks the same way, which is what
 * makes re-running ingestion idempotent in effect, not just in intent (§43).
 */
export function chunkText(text: string): TextChunk[] {
  const cleaned = text.trim();

  if (cleaned.length === 0) {
    return [];
  }

  const chunks: TextChunk[] = [];
  let start = 0;

  while (start < cleaned.length) {
    let end = Math.min(start + MAX_CHUNK_CHARS, cleaned.length);

    if (end < cleaned.length) {
      // Look for a natural boundary in the last 40% of the window, so no chunk drops below
      // the §33 floor just because a paragraph happened to break early.
      const windowFloor = start + Math.floor(MAX_CHUNK_CHARS * 0.6);
      const slice = cleaned.slice(windowFloor, end);

      const paragraphBreak = slice.lastIndexOf('\n\n');
      const sentenceEnd = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('.\n'),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('! '),
      );

      if (paragraphBreak !== -1) {
        end = windowFloor + paragraphBreak;
      } else if (sentenceEnd !== -1) {
        end = windowFloor + sentenceEnd + 1; // keep the terminator with its sentence
      }
    }

    const content = cleaned.slice(start, end).trim();

    if (content.length > 0) {
      chunks.push({
        chunkNumber: chunks.length + 1,
        content,
        tokenCount: estimateTokens(content),
      });
    }

    if (end >= cleaned.length) {
      break;
    }

    // Step back by the overlap so the next chunk re-covers the boundary.
    start = Math.max(end - OVERLAP_CHARS, start + 1);
  }

  return chunks;
}
