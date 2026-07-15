/**
 * Browser-side PDF/DOCX text extraction (FULLPLAN §33, v1.5).
 *
 * This runs HERE, in the admin's browser, because on the Workers Free plan it can run
 * nowhere else: request handlers and queue consumers both get 10 ms of CPU, and a pure-JS
 * parser would also eat most of the Worker's 3 MB bundle cap. The upload sends
 * `{ file, extracted_text }` — the raw file for provenance, this function's output as the
 * text the Worker validates, caps (§34), chunks and embeds.
 *
 * This does not move a trust boundary: the uploader is an authenticated admin who could
 * already type anything into the knowledge base, and any extraction dispute is settled
 * against the original file in R2.
 *
 * Both parsers are **dynamic imports**, so students and counselors never download a byte
 * of them — they land in their own chunks, fetched the first time an admin extracts.
 * §31 Mode A (AI-assisted assessment generation, Phase 5b) reuses this same utility.
 */

/** Mirrors the server-side §34 cap — fail here, before uploading half a megabyte for a 422. */
export const MAX_EXTRACTED_TEXT_CHARS = 500_000;

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export async function extractText(file: File): Promise<string> {
  const extension = file.name.toLowerCase().split('.').pop();

  let text: string;

  if (extension === 'pdf') {
    text = await extractPdf(file);
  } else if (extension === 'docx') {
    text = await extractDocx(file);
  } else {
    throw new ExtractionError('Only PDF and DOCX files are supported.');
  }

  const trimmed = text.trim();

  if (trimmed.length === 0) {
    throw new ExtractionError(
      'No text could be extracted. If this is a scanned document, it has no text layer to read.',
    );
  }

  if (trimmed.length > MAX_EXTRACTED_TEXT_CHARS) {
    throw new ExtractionError(
      `The document's text (${trimmed.length.toLocaleString()} characters) exceeds the ${MAX_EXTRACTED_TEXT_CHARS.toLocaleString()}-character limit. Split it into smaller documents.`,
    );
  }

  return trimmed;
}

async function extractPdf(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;

  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();

      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' '),
      );
    }
  } finally {
    void document.cleanup();
  }

  return pages.join('\n\n');
}

async function extractDocx(file: File): Promise<string> {
  const mammoth = await import('mammoth');

  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });

  return value;
}
