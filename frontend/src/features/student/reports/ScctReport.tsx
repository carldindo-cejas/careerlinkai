import { scctContent } from '@/features/student/reports/reportContent';
import { count, pct } from '@/features/student/reports/reportMath';
import {
  Acknowledgement,
  BandsTable,
  ItemAppendix,
  LikertDistribution,
  ReportDocument,
} from '@/features/student/reports/reportParts';
import type { AssessmentReport } from '@/types/assessment';

/**
 * The SCCT results export — `docs_report/…/CareerLinkAI SCCT Report.dc.html` as a React
 * component. Layout, copy and section order follow that mockup.
 *
 * The Career Confidence Index is recomputed from the construct scores and the version's weights
 * (§23) — see `scctContent`, which the downloaded PDF reads as well.
 */

export interface ScctReportProps {
  report: AssessmentReport;
  showAppendix?: boolean;
}

export function ScctReport({ report, showAppendix = true }: ScctReportProps) {
  const content = scctContent(report);
  const { dims, normalization, composite } = content;

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
          <div className="mono rr-hero-value">{content.index}</div>
          <div className="mono rr-hero-sub">{content.meanLine}</div>
        </div>
        <div className="rr-hero-body">
          <div className="rr-hero-summary">{content.summary}</div>
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
              <th style={{ width: '23%' }}>Construct</th>
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
              <th style={{ width: '18%' }}>Distribution</th>
              <th className="num" style={{ width: '8%' }}>
                Weight
              </th>
              <th style={{ width: '15%' }}>Band</th>
            </tr>
          </thead>
          <tbody>
            {dims.map((dimension) => (
              <tr key={dimension.code}>
                <td className="mono rr-strong">{dimension.code}</td>
                <td className="rr-medium">
                  {dimension.name}
                  {dimension.description ? (
                    <div className="rr-dim-desc">{dimension.description}</div>
                  ) : null}
                </td>
                <td className="num">{count(dimension.raw)}</td>
                <td className="num">{count(dimension.max)}</td>
                <td className="num rr-strong">{pct(dimension.pct)}</td>
                <td className="num">{dimension.mean.toFixed(2)}</td>
                <td>
                  <div className="bar" aria-hidden="true">
                    <i style={{ width: `${Math.min(100, Math.max(0, dimension.pct))}%` }} />
                  </div>
                </td>
                <td className="num">
                  {dimension.weight === null ? '—' : dimension.weight.toFixed(2)}
                </td>
                <td>{dimension.band}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="sec">How these numbers were calculated</h2>
        <div className="rr-grid-2 rr-grid-2-wide">
          <div className="panel">
            <div className="rk">{normalization.kicker}</div>
            <p className="mono rr-formula">{normalization.formula}</p>
            {normalization.example ? (
              <p className="mono rr-example">{normalization.example}</p>
            ) : null}
          </div>
          <div className="panel">
            <div className="rk">{composite.kicker}</div>
            <p className="mono rr-composite">
              {composite.formula}
              <br />
              &nbsp;&nbsp;= {composite.terms}
              <br />
              &nbsp;&nbsp;= {composite.products}
              <br />
              &nbsp;&nbsp;{composite.divisor} <b>{content.index}</b>
            </p>
            <p className="rr-fine">{composite.fine}</p>
          </div>
        </div>
      </section>

      <div className="rr-grid-dist">
        <LikertDistribution report={report} />
        <BandsTable heading={content.bandsHeading} />
      </div>

      <Acknowledgement report={report} text={content.acknowledgement} />

      {showAppendix ? <ItemAppendix report={report} dims={dims} /> : null}
    </ReportDocument>
  );
}
