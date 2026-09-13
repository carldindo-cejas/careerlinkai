import { describe, expect, it } from 'vitest';

import { createReportsPdf } from '@/features/student/reports/pdf/reportPdf';
import { riasecReport, scctReport } from '@/features/student/reports/reportFixtures';

/**
 * The downloaded PDF, read back the way a student's PDF viewer reads it — in real Chrome, through
 * pdf.js, the same path `extractText.ts` takes (and for the same reason: pdf.js needs a real
 * `Worker`, so this runs in the browser project, not jsdom).
 *
 * Reading the text back proves more than that the file opens: every glyph was embedded with a
 * Unicode mapping (so the PDF is searchable and copyable), the fallback face covered what Barlow
 * lacks ("→"), and the reports flow on from one another instead of breaking to a fresh page.
 */

async function pagesOf(blob: Blob): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;

  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const document = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const pages: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const content = await (await document.getPage(pageNumber)).getTextContent();

      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' '),
      );
    }
  } finally {
    void document.cleanup();
  }

  return pages;
}

describe('the downloaded report PDF', () => {
  it('carries both reports, in order, as searchable text', async () => {
    const { blob, pages: count } = await createReportsPdf([scctReport(), riasecReport()], {
      recommendations: null,
      showRecommendations: true,
      showAppendix: true,
    });
    const pages = await pagesOf(blob);
    const all = pages.join(' ');

    expect(pages).toHaveLength(count);

    for (const expected of [
      'RIASEC Interest Inventory',
      'Maria Louise A. Fernandez',
      'Grade 12 – Newton (Section B)',
      'Investigative · Artistic · Social',
      'I 90.0 > A 82.0 > S 74.0 → IAS',
      'Investigative: (45 ÷ 50) × 100 = 90.0',
      'Appendix A — Item responses',
      'SCCT Career Confidence Scale',
      'High Career Confidence.',
      'index = ∑(score × weight) ÷ ∑(weight)',
      'CONFIDENTIAL',
    ]) {
      expect(all, expected).toContain(expected);
    }

    expect(all.indexOf('RIASEC Interest Inventory')).toBeLessThan(
      all.indexOf('SCCT Career Confidence Scale'),
    );
  });

  /** The complaint this answers: long blank stretches where a section waited for a fresh page. */
  it('flows each part on from the last, with no forced page breaks', async () => {
    const { blob } = await createReportsPdf([riasecReport(), scctReport()], {
      recommendations: null,
      showRecommendations: true,
      showAppendix: true,
    });
    const pages = await pagesOf(blob);
    const pageWith = (text: string) => pages.findIndex((page) => page.includes(text));

    // The appendix starts on the page the acknowledgement's signature row is on…
    expect(pageWith('Appendix A — Item responses')).not.toBe(-1);
    expect(pageWith('Appendix A — Item responses')).toBe(pageWith('Date received'));
    // …and the SCCT report's title block is on the page the RIASEC appendix ends on. (Anchored on
    // the title: the running header's letter-spaced kicker does not read back as one string.)
    expect(pageWith('SCCT Career Confidence Scale')).not.toBe(-1);
    expect(pageWith('SCCT Career Confidence Scale')).toBe(pageWith('Conventional item 60'));
  });
});
