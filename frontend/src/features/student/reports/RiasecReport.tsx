import { riasecContent, type MatchRow } from '@/features/student/reports/reportContent';
import { count, pct } from '@/features/student/reports/reportMath';
import {
  Acknowledgement,
  BandsTable,
  ItemAppendix,
  LikertDistribution,
  ReportDocument,
} from '@/features/student/reports/reportParts';
import type { AssessmentReport } from '@/types/assessment';
import type { RecommendationSet } from '@/types/recommendation';

/**
 * The RIASEC results export — `docs_report/…/CareerLinkAI RIASEC Report.dc.html` as a React
 * component. Layout, copy and section order follow that mockup; the numbers come from the scoring
 * response. The Holland Code is the server's, tie-break included — this never re-ranks.
 *
 * Pure: everything it prints arrives as props, by way of `riasecContent` — which the downloaded
 * PDF reads as well. `ResultReportPage` fetches and adds the print controls.
 */

export interface RiasecReportProps {
  report: AssessmentReport;
  /** The student's current set, or null when they have none yet. Drawn as "Top matches". */
  recommendations?: RecommendationSet | null;
  showRecommendations?: boolean;
  showAppendix?: boolean;
}

export function RiasecReport({
  report,
  recommendations = null,
  showRecommendations = true,
  showAppendix = true,
}: RiasecReportProps) {
  const content = riasecContent(report, recommendations);
  const { holland, dims, normalization, tieBreak, matches } = content;

  return (
    <ReportDocument
      report={report}
      label={content.label}
      kicker={content.kicker}
      headline={content.headline}
      title={content.title}
      subtitle={content.subtitle}
    >
      <section className="panel rr-hero">
        <div className="rr-hero-code">
          <div className="rk">{content.heroKicker}</div>
          <div className="mono rr-hero-value rr-hero-code-letters">
            <span aria-hidden="true">{holland}</span>
            <span className="sr-only">{holland.split('').join(' ')}</span>
          </div>
        </div>
        <div className="rr-hero-body">
          <div className="rr-hero-top3">{content.topThree}</div>
          <p>{content.heroNote}</p>
        </div>
      </section>

      <section className="rr-section">
        <h2 className="sec">{content.breakdownTitle}</h2>
        <p className="rk rr-lead">{content.breakdownLead}</p>
        <table className="rt">
          <thead>
            <tr>
              <th style={{ width: '6%' }}>Code</th>
              <th style={{ width: '22%' }}>Dimension</th>
              <th className="num" style={{ width: '7%' }}>
                Raw
              </th>
              <th className="num" style={{ width: '7%' }}>
                Max
              </th>
              <th className="num" style={{ width: '8%' }}>
                Score
              </th>
              <th className="num" style={{ width: '8%' }}>
                Mean
              </th>
              <th style={{ width: '22%' }}>Distribution</th>
              <th style={{ width: '20%' }}>Band</th>
            </tr>
          </thead>
          <tbody>
            {dims.map((dimension) => (
              <tr key={dimension.code}>
                <td className="mono rr-strong">{dimension.code}</td>
                <td className="rr-medium">{dimension.name}</td>
                <td className="num">{count(dimension.raw)}</td>
                <td className="num">{count(dimension.max)}</td>
                <td className="num rr-strong">{pct(dimension.pct)}</td>
                <td className="num">{dimension.mean.toFixed(2)}</td>
                <td>
                  <div className="bar" aria-hidden="true">
                    <i style={{ width: `${Math.min(100, Math.max(0, dimension.pct))}%` }} />
                  </div>
                </td>
                <td>{dimension.band}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="sec">How these numbers were calculated</h2>
        <div className="rr-grid-2">
          <div className="panel">
            <div className="rk">{normalization.kicker}</div>
            <p className="mono rr-formula">{normalization.formula}</p>
            <p className="rr-note">{normalization.note}</p>
            {normalization.example ? (
              <p className="mono rr-example">{normalization.example}</p>
            ) : null}
          </div>
          <div className="panel">
            <div className="rk">{tieBreak.kicker}</div>
            <p className="rr-note">{tieBreak.note}</p>
            {tieBreak.example ? <p className="mono rr-example">{tieBreak.example}</p> : null}
          </div>
        </div>
      </section>

      <div className="rr-grid-dist">
        <LikertDistribution report={report} />
        <BandsTable heading={content.bandsHeading} />
      </div>

      {showRecommendations && matches.any ? (
        <section className="rr-section">
          <h2 className="sec">{matches.title}</h2>
          <p className="rk rr-lead">{matches.lead}</p>
          <div className="rr-grid-matches">
            <MatchTable heading="Program recommendations" noun="Program" rows={matches.programs} />
            <MatchTable heading="Career recommendations" noun="Career" rows={matches.careers} />
          </div>
        </section>
      ) : null}

      <Acknowledgement report={report} text={content.acknowledgement} />

      {showAppendix ? <ItemAppendix report={report} dims={dims} /> : null}
    </ReportDocument>
  );
}

function MatchTable({ heading, noun, rows }: { heading: string; noun: string; rows: MatchRow[] }) {
  return (
    <div>
      <div className="rk rr-subhead rr-subhead-strong">{heading}</div>
      <table className="rt">
        <thead>
          <tr>
            <th className="num" style={{ width: '10%' }}>
              #
            </th>
            <th>{noun}</th>
            <th className="num" style={{ width: '15%' }}>
              Code
            </th>
            <th className="num" style={{ width: '17%' }}>
              Match
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4}>None yet.</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.rank}>
                <td className="num">{row.rank}</td>
                <td className="rr-medium">
                  {row.title}
                  <div className="rr-reason">{row.reason}</div>
                </td>
                <td className="num mono">{row.code}</td>
                <td className="num rr-strong">{row.match}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
