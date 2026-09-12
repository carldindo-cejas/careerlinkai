import { Download, Printer } from 'lucide-react';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { useReports, useResults } from '@/features/student/hooks/useAssessment';
import { useMyRecommendations } from '@/features/student/hooks/useRecommendations';
import { bandFor, itemMean } from '@/features/student/reports/likertBands';
import { compositeIndex, formatDate } from '@/features/student/reports/reportMath';
import { useReportDownload } from '@/features/student/reports/useReportDownload';
import { useClientPagination } from '@/hooks/useClientPagination';
import { paths, reportsPath, resultPath, type ResultPageState } from '@/routes/paths';
import type { AssessmentReport, AssessmentResult, DimensionScore } from '@/types/assessment';

/**
 * "My results" (FULLPLAN §37), laid out as `docs_report/…/CareerLinkAI Results Screen.dc.html`:
 * the two standing instruments side by side and, below them, every other assessment the student
 * has finished, a page at a time. The matches the two produce live on "My recommendations".
 *
 * Only SCORED attempts appear (§21). The list arrives newest first, so the first RIASEC and the
 * first SCCT are the standing ones; an older one (a second class that assigned it too) falls to the
 * list below with everything else.
 *
 * The cards read the scoring response. The report endpoint adds what the list does not carry — the
 * item count, raw / max and the version's composite weights — and the SCCT index is recomputed from
 * those (§23), never parsed out of the summary sentence.
 */

const OTHER_PER_PAGE = 5;

const KICKER = 'font-heading text-xs uppercase tracking-[0.14em] text-accent';

const FROM_RESULTS: ResultPageState = { from: paths.studentResults, fromLabel: 'My results' };

const ACKNOWLEDGEMENT =
  'These results are intended to support self-awareness, career exploration, and informed ' +
  'educational planning. The recommendations are not final career decisions or guarantees of ' +
  'success. Students are encouraged to reflect on their interests, abilities, goals, personal ' +
  'circumstances, and available opportunities, and to discuss their results with a teacher, ' +
  'guidance counselor, or parent.';

export function ResultListPage() {
  const { data: results, isLoading, isError, error } = useResults();
  const navigate = useNavigate();
  const [exportOpen, setExportOpen] = useState(false);
  const [exportChoice, setExportChoice] = useState<ExportChoice>('both');

  const all = results ?? [];
  const riasec = all.find((result) => result.assessment?.category === 'RIASEC');
  const scct = all.find((result) => result.assessment?.category === 'SCCT');
  const headline = [riasec, scct].filter((r): r is AssessmentResult => r !== undefined);
  const others = all.filter((result) => result !== riasec && result !== scct);

  const reports = useReports(headline.map((result) => result.attempt_id));
  const reportById = (attemptId: string) =>
    reports.find((query) => query.data?.attempt_id === attemptId)?.data;
  const reportFor = (result: AssessmentResult) => reportById(result.attempt_id);

  const recommendations = useMyRecommendations();
  const { download, downloading, failed: downloadFailed, reset: resetDownload } =
    useReportDownload();

  const { pageItems, pagination, setPage } = useClientPagination(others, OTHER_PER_PAGE);

  const openExport = (choice: ExportChoice) => {
    resetDownload();
    setExportChoice(choice);
    setExportOpen(true);
  };

  if (isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading your results…
      </p>
    );
  }

  const kicker =
    headline.length === 2
      ? 'Both assessments complete'
      : headline.length === 1
        ? '1 of 2 assessments complete'
        : 'No assessments complete yet';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            {isError ? null : <p className={KICKER}>{kicker}</p>}
            <h1 className="text-3xl font-semibold text-foreground">My results</h1>
          </div>

          {!isError && riasec && scct ? (
            <Button
              variant="secondary"
              onClick={() =>
                navigate(reportsPath([riasec.attempt_id, scct.attempt_id], { print: true }))
              }
            >
              <Printer className="size-4" aria-hidden="true" />
              Print results
            </Button>
          ) : null}
        </div>

        <p className="mx-auto max-w-prose text-center text-sm text-muted-foreground">
          Your RIASEC interest profile and your SCCT career confidence, then every other assessment
          you have finished. Each score is out of 100 and shows how strongly something came through
          in your answers — not how well you did. There is no pass mark.
        </p>
      </div>

      {/* D11 — a failed load must not be reported as "not completed yet". See AssessmentListPage. */}
      {isError ? (
        <Alert>{error.message}</Alert>
      ) : (
        <>
          <div className="grid gap-5 xl:grid-cols-2">
            {riasec ? (
              <RiasecCard
                result={riasec}
                report={reportFor(riasec)}
                onExport={() => openExport('riasec')}
              />
            ) : (
              <MissingCard title="RIASEC Interest Inventory" />
            )}
            {scct ? (
              <ScctCard
                result={scct}
                report={reportFor(scct)}
                onExport={() => openExport('scct')}
              />
            ) : (
              <MissingCard title="SCCT Career Confidence Scale" />
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Other assessment results</CardTitle>
              <CardDescription>
                Every other assessment your counselor assigned and you finished, newest first.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {others.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing else yet. Any other assessment you finish will appear here.
                </p>
              ) : (
                <ul className="flex flex-col">
                  {pageItems.map((result) => (
                    <OtherResultRow key={result.attempt_id} result={result} />
                  ))}
                </ul>
              )}

              <Pagination
                pagination={pagination}
                onPageChange={setPage}
                noun="results"
                showSinglePage
              />
            </CardContent>
          </Card>

          <p className="mx-auto max-w-prose text-center text-xs text-muted-foreground">
            {ACKNOWLEDGEMENT}
          </p>
        </>
      )}

      <ExportDialog
        // Remounted per card, so the dialog opens on the report whose Export was pressed.
        key={exportChoice}
        initialChoice={exportChoice}
        open={exportOpen}
        onOpenChange={setExportOpen}
        riasec={riasec}
        scct={scct}
        canDownload={(attemptIds) =>
          attemptIds.every((id) => reportById(id) !== undefined) && !recommendations.isLoading
        }
        downloading={downloading}
        downloadFailed={downloadFailed}
        onPrint={(attemptIds, options) =>
          navigate(reportsPath(attemptIds, { ...options, print: true }))
        }
        onDownload={async (attemptIds, options) => {
          const chosen = attemptIds.flatMap((id) => reportById(id) ?? []);
          const saved = await download(chosen, {
            recommendations: recommendations.data ?? null,
            showAppendix: options.appendix,
            showRecommendations: options.matches,
          });

          if (saved) setExportOpen(false);
        }}
      />
    </div>
  );
}

function InstrumentHeading({
  title,
  short,
  result,
  report,
  onExport,
}: {
  title: string;
  short: string;
  result: AssessmentResult;
  report: AssessmentReport | undefined;
  onExport: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className={KICKER}>{title}</h2>
        <p className="text-xs text-muted-foreground">
          {report ? `${report.instrument.question_count} items · ` : ''}completed{' '}
          {formatDate(result.submitted_at, 'short')}
        </p>
      </div>
      <Button size="sm" aria-label={`Export ${short} results`} onClick={onExport}>
        <Download className="size-4" aria-hidden="true" />
        Export
      </Button>
    </div>
  );
}

function DimensionBars({
  dimensions,
  noun,
}: {
  dimensions: DimensionScore[];
  noun: 'Interest' | 'Confidence';
}) {
  return (
    <ul className="flex flex-col gap-2.5">
      {dimensions.map((dimension) => {
        const score = Number(dimension.normalized_score);

        return (
          <li key={dimension.code}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 wrap-break-word text-foreground">
                <span className="mr-2 font-mono text-muted-foreground">{dimension.code}</span>
                {dimension.name}
              </span>
              <span className="shrink-0 whitespace-nowrap font-mono tabular-nums text-muted-foreground">
                {score.toFixed(1)}
                <span className="sr-only"> out of 100</span> ·{' '}
                {dimension.interpretation ?? `${bandFor(score).label} ${noun}`}
              </span>
            </div>
            {/* A redraw of the number beside it, so it is hidden rather than read twice. */}
            <div aria-hidden="true" className="h-2 border border-border bg-secondary">
              <div
                className="h-full bg-primary"
                style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RiasecCard({
  result,
  report,
  onExport,
}: {
  result: AssessmentResult;
  report: AssessmentReport | undefined;
  onExport: () => void;
}) {
  const code = result.result?.result_code ?? '';
  // The server's code, letter by letter — the tie-break is already applied; nothing re-ranks here.
  const top3 = code
    .split('')
    .map((letter) => result.dimensions.find((dimension) => dimension.code === letter)?.name)
    .filter((name): name is string => name !== undefined)
    .join(' · ');

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 p-6">
        <InstrumentHeading
          title="RIASEC Interest Inventory"
          short="RIASEC"
          result={result}
          report={report}
          onExport={onExport}
        />

        <div className="flex flex-wrap items-center gap-4">
          {/* Spelled out for a screen reader, which would otherwise say "IAS" as a word. */}
          <p className="font-mono text-5xl font-bold leading-none tracking-[0.16em] text-foreground">
            <span aria-hidden="true">{code}</span>
            <span className="sr-only">{code.split('').join(' ')}</span>
          </p>
          <p className="text-sm leading-snug">
            <strong className="text-foreground">Your Holland Code</strong>
            <br />
            <span className="text-muted-foreground">{top3}</span>
          </p>
        </div>

        <DimensionBars dimensions={result.dimensions} noun="Interest" />
      </CardContent>
    </Card>
  );
}

function ScctCard({
  result,
  report,
  onExport,
}: {
  result: AssessmentResult;
  report: AssessmentReport | undefined;
  onExport: () => void;
}) {
  const composite = report
    ? compositeIndex(
        result.dimensions.map((dimension) => ({
          code: dimension.code,
          pct: Number(dimension.normalized_score),
        })),
        report.instrument.composite_weights,
      )
    : null;
  const band = composite ? bandFor(composite.index) : null;
  const summary =
    result.result?.overall_summary ?? (band ? `${band.label} Career Confidence.` : null);

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 p-6">
        <InstrumentHeading
          title="SCCT Career Confidence Scale"
          short="SCCT"
          result={result}
          report={report}
          onExport={onExport}
        />

        <div className="flex flex-wrap items-center gap-4">
          <p className="font-mono text-5xl font-bold leading-none tabular-nums text-foreground">
            <span className="sr-only">Career Confidence Index </span>
            {composite ? composite.index.toFixed(1) : '—'}
          </p>
          <p className="text-sm leading-snug">
            {summary ? <strong className="text-foreground">{summary}</strong> : null}
            {composite ? (
              <>
                <br />
                <span className="text-muted-foreground">
                  item mean {itemMean(composite.index).toFixed(2)} / 5.00
                </span>
                {composite.terms.length > 0 ? (
                  <>
                    <br />
                    <span className="text-muted-foreground">
                      Weighted index — {composite.terms.map((t) => `${t.code} ${t.weight}`).join(', ')}
                    </span>
                  </>
                ) : null}
              </>
            ) : null}
          </p>
        </div>

        <DimensionBars dimensions={result.dimensions} noun="Confidence" />
      </CardContent>
    </Card>
  );
}

function MissingCard({ title }: { title: string }) {
  const navigate = useNavigate();

  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-start gap-3 p-6">
        <h2 className={KICKER}>{title}</h2>
        <p className="text-sm text-muted-foreground">
          Not completed yet. Once you finish it, your result appears here straight away.
        </p>
        <Button variant="secondary" size="sm" onClick={() => navigate(paths.studentAssessments)}>
          Go to my assessments
        </Button>
      </CardContent>
    </Card>
  );
}

function summaryOf(result: AssessmentResult): string {
  if (result.result?.result_code) return `Holland Code ${result.result.result_code}`;
  if (result.result?.overall_summary) return result.result.overall_summary;

  const measured = result.dimensions.length;

  return measured > 0
    ? `${measured} dimension${measured === 1 ? '' : 's'} measured`
    : 'Completed — this assessment is not scored';
}

function OtherResultRow({ result }: { result: AssessmentResult }) {
  const navigate = useNavigate();
  const title = result.assessment?.title ?? 'Assessment';

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">
          {summaryOf(result)} · completed {formatDate(result.submitted_at, 'short')}
        </p>
      </div>
      <div className="flex items-center gap-3">
        {result.assessment?.category ? (
          <Badge tone="outline">{result.assessment.category}</Badge>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          aria-label={`See the ${title} breakdown`}
          onClick={() => navigate(resultPath(result.attempt_id), { state: FROM_RESULTS })}
        >
          See breakdown
        </Button>
      </div>
    </li>
  );
}

type ExportChoice = 'both' | 'riasec' | 'scct';

interface ExportOptions {
  appendix: boolean;
  matches: boolean;
}

/**
 * What to export — the mockup's dialog, with the two ways out a student asked for: **Print** opens
 * the print sheet with the browser's print dialog already up, and **Download PDF** saves the same
 * report as a file straight away, without leaving this page. Nothing is rendered server-side.
 */
function ExportDialog({
  initialChoice,
  open,
  onOpenChange,
  riasec,
  scct,
  canDownload,
  downloading,
  downloadFailed,
  onPrint,
  onDownload,
}: {
  /** The report the dialog opens on — the card whose Export was pressed. */
  initialChoice: ExportChoice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  riasec: AssessmentResult | undefined;
  scct: AssessmentResult | undefined;
  /** False until every chosen report has loaded — the file is built from them. */
  canDownload: (attemptIds: string[]) => boolean;
  downloading: boolean;
  downloadFailed: boolean;
  onPrint: (attemptIds: string[], options: ExportOptions) => void;
  onDownload: (attemptIds: string[], options: ExportOptions) => void;
}) {
  const [requested, setRequested] = useState<ExportChoice>(initialChoice);
  const [appendix, setAppendix] = useState(true);
  const [matches, setMatches] = useState(true);
  const groupName = useId();

  const choices: { value: ExportChoice; label: string; detail: string; ids: string[] }[] = [];

  if (riasec && scct) {
    choices.push({
      value: 'both',
      label: 'Both reports',
      detail: 'RIASEC + SCCT, one after the other',
      ids: [riasec.attempt_id, scct.attempt_id],
    });
  }
  if (riasec) {
    choices.push({
      value: 'riasec',
      label: 'RIASEC only',
      detail: 'Interest profile and Holland Code',
      ids: [riasec.attempt_id],
    });
  }
  if (scct) {
    choices.push({
      value: 'scct',
      label: 'SCCT only',
      detail: 'Career Confidence Index',
      ids: [scct.attempt_id],
    });
  }

  const selected = choices.find((choice) => choice.value === requested) ?? choices[0];
  const includesRiasec = selected !== undefined && selected.value !== 'scct';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Export results"
        description="Print it now, or download it as a PDF file to keep or share."
        className="max-w-md"
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Which reports</legend>
          {choices.map((choice) => (
            <label
              key={choice.value}
              className="flex cursor-pointer items-start gap-3 border border-border p-3 has-checked:border-primary"
            >
              <input
                type="radio"
                name={groupName}
                value={choice.value}
                checked={selected?.value === choice.value}
                onChange={() => setRequested(choice.value)}
                className="mt-1 accent-primary"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">{choice.label}</span>
                <span className="block text-xs text-muted-foreground">{choice.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="mt-4 flex flex-col gap-2 text-sm text-foreground">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={appendix}
              onChange={(event) => setAppendix(event.target.checked)}
              className="accent-primary"
            />
            Include item appendix
          </label>
          {includesRiasec ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={matches}
                onChange={(event) => setMatches(event.target.checked)}
                className="accent-primary"
              />
              Include top matches
            </label>
          ) : null}
          <p className="text-xs text-muted-foreground">Paper: A4</p>
        </div>

        {downloadFailed ? (
          <Alert className="mt-4">
            The PDF could not be created. Try again, or choose Print and save it as a PDF from the
            print dialog.
          </Alert>
        ) : null}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={selected === undefined}
            onClick={() => {
              if (selected) onPrint(selected.ids, { appendix, matches });
            }}
          >
            <Printer className="size-4" aria-hidden="true" />
            Print
          </Button>
          <Button
            loading={downloading}
            disabled={selected === undefined || downloading || !canDownload(selected.ids)}
            onClick={() => {
              if (selected) onDownload(selected.ids, { appendix, matches });
            }}
          >
            {downloading ? null : <Download className="size-4" aria-hidden="true" />}
            {downloading ? 'Preparing PDF…' : 'Download PDF'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
