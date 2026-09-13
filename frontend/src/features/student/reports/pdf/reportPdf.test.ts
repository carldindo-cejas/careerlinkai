import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReportsPdf, reportFileName } from '@/features/student/reports/pdf/reportPdf';
import { riasecReport, scctReport } from '@/features/student/reports/reportFixtures';

/**
 * The real builder — jsPDF with the real embedded fonts — end to end in jsdom. What the text says
 * is checked in real Chrome (`reportPdf.browser.test.ts`); this proves the file is built at all,
 * from every section, with the fonts and logo the bundle ships.
 *
 * The fonts and logo are `?url` imports, served by Vite in the app. Here the same URLs are read
 * from disk.
 */

beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string) => {
    const bytes = readFileSync(resolve(process.cwd(), `.${url.split('?')[0] ?? ''}`));

    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const FULL = { recommendations: null, showRecommendations: true, showAppendix: true };

describe('createReportsPdf', () => {
  it('builds both reports, RIASEC first, into one PDF', async () => {
    const { blob, filename, pages } = await createReportsPdf([scctReport(), riasecReport()], FULL);

    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBeGreaterThan(10_000);
    expect(filename).toBe('CareerLinkAI-Results-Maria-Louise-A-Fernandez.pdf');
    expect(pages).toBeGreaterThanOrEqual(3);
  });

  it('is shorter without the item appendix', async () => {
    const withAppendix = await createReportsPdf([riasecReport(), scctReport()], FULL);
    const without = await createReportsPdf([riasecReport(), scctReport()], {
      ...FULL,
      showAppendix: false,
    });

    expect(without.pages).toBeLessThan(withAppendix.pages);
  });

  it('refuses a set with no RIASEC or SCCT report in it', async () => {
    const custom = { ...scctReport(), assessment: { title: 'Custom', category: 'CUSTOM' as const } };

    await expect(createReportsPdf([custom], FULL)).rejects.toThrow(/no RIASEC or SCCT report/);
  });
});

describe('reportFileName', () => {
  it('names one report by its instrument and keeps the name to plain ASCII', () => {
    const report = scctReport();
    report.student.name = 'José Peñaflor-Niño';

    expect(reportFileName([report])).toBe('CareerLinkAI-SCCT-Report-Jose-Penaflor-Nino.pdf');
  });
});
