import { useCallback, useState } from 'react';

import type { ReportPdfOptions } from '@/features/student/reports/pdf/reportPdf';
import type { AssessmentReport } from '@/types/assessment';

/**
 * "Download PDF" — the report as a file, without a print dialog.
 *
 * The PDF builder is an `import()`, not a static import: jsPDF and the embedded fonts are a few
 * hundred KB that nobody should pay for until they press the button, and the route-weight gate
 * (backend/scripts/lib/route-weight.mjs) counts only static edges. Keep it that way — a static
 * import of `pdf/reportPdf` anywhere on the student route puts all of it on that route.
 */
export function useReportDownload() {
  const [status, setStatus] = useState<'idle' | 'working' | 'failed'>('idle');

  /** Resolves true once the browser has the file, false if it could not be made. */
  const download = useCallback(
    async (reports: AssessmentReport[], options: ReportPdfOptions): Promise<boolean> => {
      setStatus('working');

      try {
        const { downloadReportsPdf } = await import('@/features/student/reports/pdf/reportPdf');

        await downloadReportsPdf(reports, options);
        setStatus('idle');

        return true;
      } catch (error) {
        console.error('The report PDF could not be created.', error);
        setStatus('failed');

        return false;
      }
    },
    [],
  );

  const reset = useCallback(() => setStatus('idle'), []);

  return { download, downloading: status === 'working', failed: status === 'failed', reset };
}
