import { Download, Printer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { useReports } from '@/features/student/hooks/useAssessment';
import { useMyRecommendations } from '@/features/student/hooks/useRecommendations';
import { inReportOrder } from '@/features/student/reports/reportContent';
import { Corners } from '@/features/student/reports/reportParts';
import { RiasecReport } from '@/features/student/reports/RiasecReport';
import { ScctReport } from '@/features/student/reports/ScctReport';
import { useReportDownload } from '@/features/student/reports/useReportDownload';
import { paths, resultPath } from '@/routes/paths';

/**
 * The printable exports, as a screen — one report (`/student/results/:attemptId/report`, from a
 * result's "Print report") or several on one sheet (`/student/reports?attempts=…`, from "Print
 * both" and the export dialog on My results). RIASEC always comes first: it is Report 1 of 2.
 *
 * Two ways out, side by side: **Print** hands the sheet to the browser's print dialog, and
 * **Download PDF** builds the same report as a file (`useReportDownload`) with no dialog at all.
 * Both honour the section toggles.
 *
 * `appendix=0` / `matches=0` pre-set the toggles. `print=1` opens the browser's print dialog once
 * every report has loaded, and is then dropped from the URL so a reload does not print a second
 * time.
 *
 * Rendered outside the student shell (see router.tsx) — the page is the sheet.
 */
export function ResultReportPage() {
  const { attemptId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const attemptIds =
    attemptId !== undefined
      ? [attemptId]
      : (searchParams.get('attempts') ?? '').split(',').filter((id) => id !== '');
  const queries = useReports(attemptIds);
  // Not `isError`-gated: a set that fails to load costs the "Top matches" panel, not the report.
  const recommendations = useMyRecommendations();
  const { download, downloading, failed } = useReportDownload();

  const [showRecommendations, setShowRecommendations] = useState(
    searchParams.get('matches') !== '0',
  );
  const [showAppendix, setShowAppendix] = useState(searchParams.get('appendix') !== '0');

  const loading = queries.some((query) => query.isLoading) || recommendations.isLoading;
  const failedToLoad = queries.some((query) => query.isError);
  const reports = inReportOrder(queries.flatMap((query) => (query.data ? [query.data] : [])));

  const ready = !loading && !failedToLoad && reports.length > 0;
  const wantsPrint = searchParams.get('print') === '1';
  const printed = useRef(false);

  useEffect(() => {
    if (!ready || !wantsPrint || printed.current) return;

    printed.current = true;

    // After the web fonts, or the sheet prints in the fallback face.
    const run = () => window.print();

    if ('fonts' in document) {
      void document.fonts.ready.then(run);
    } else {
      run();
    }

    const next = new URLSearchParams(searchParams);
    next.delete('print');
    setSearchParams(next, { replace: true });
  }, [ready, wantsPrint, searchParams, setSearchParams]);

  if (loading) {
    return (
      <p role="status" className="p-6 text-sm text-muted-foreground">
        Preparing your report…
      </p>
    );
  }

  if (attemptIds.length === 0 || failedToLoad) {
    return (
      <div className="p-6">
        <Alert tone="danger">
          {attemptIds.length === 0
            ? 'No report was chosen to print.'
            : 'This report could not be loaded.'}
        </Alert>
      </div>
    );
  }

  if (reports.length === 0) {
    return (
      <div className="p-6">
        <Alert tone="danger">
          Printable reports exist for the RIASEC Interest Inventory and the SCCT Career Confidence
          Scale only.
        </Alert>
      </div>
    );
  }

  const hasRiasec = reports.some((report) => report.assessment?.category === 'RIASEC');

  return (
    <div className="industry">
      <div className="rr rr-toolbar" role="toolbar" aria-label="Report controls">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() =>
            navigate(attemptId !== undefined ? resultPath(attemptId) : paths.studentResults)
          }
        >
          {attemptId !== undefined ? 'Back to result' : 'Back to my results'}
        </button>
        <span className="rr-fill" />
        {hasRiasec ? (
          <label className="rr-toggle">
            <input
              type="checkbox"
              checked={showRecommendations}
              onChange={(event) => setShowRecommendations(event.target.checked)}
            />
            Top matches
          </label>
        ) : null}
        <label className="rr-toggle">
          <input
            type="checkbox"
            checked={showAppendix}
            onChange={(event) => setShowAppendix(event.target.checked)}
          />
          Item appendix
        </label>
        <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden="true" />
          Print
        </button>
        <button
          type="button"
          className="btn btn-primary blueprint"
          disabled={downloading}
          onClick={() =>
            void download(reports, {
              recommendations: recommendations.data ?? null,
              showRecommendations,
              showAppendix,
            })
          }
        >
          <Corners />
          <Download className="size-4" aria-hidden="true" />
          {downloading ? 'Preparing PDF…' : 'Download PDF'}
        </button>
        {failed ? (
          <p role="alert" className="rr-toolbar-error">
            The PDF could not be created. Try again, or choose Print and save it as a PDF from
            the print dialog.
          </p>
        ) : null}
      </div>

      {reports.map((report) =>
        report.assessment?.category === 'RIASEC' ? (
          <RiasecReport
            key={report.attempt_id}
            report={report}
            recommendations={recommendations.data ?? null}
            showRecommendations={showRecommendations}
            showAppendix={showAppendix}
          />
        ) : (
          <ScctReport key={report.attempt_id} report={report} showAppendix={showAppendix} />
        ),
      )}
    </div>
  );
}
