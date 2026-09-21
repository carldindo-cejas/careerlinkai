import type { ReactNode } from 'react';

import logoUrl from '@/assets/careerlinkai_logo-256.png';
import {
  APPENDIX_COPY,
  appendixScore,
  BAND_ROWS,
  FRAME_COPY,
  identityOf,
  likertTally,
  SIGNATURE_LABELS,
} from '@/features/student/reports/reportContent';
import { count, type ReportDimension } from '@/features/student/reports/reportMath';
import type { AssessmentReport } from '@/types/assessment';

import '@/features/student/reports/industry.css';
import '@/features/student/reports/report.css';

/**
 * What the two printed reports share (docs_report/): the page frame with its running header and
 * footer, the title and identity block, the Likert tally, the bands table, the acknowledgement
 * and the item appendix. Each report composes these around its own headline and breakdown.
 *
 * The words and figures come from `reportContent`, which the downloaded PDF reads too; this file
 * only decides how the sheet looks.
 */

export function Corners() {
  return (
    <>
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
    </>
  );
}

export interface ReportDocumentProps {
  report: AssessmentReport;
  /** "Report 1 of 2 · RIASEC Interest Inventory" */
  kicker: string;
  /** The running header's right-hand line above the date — "Holland Code IAS". */
  headline: string;
  title: string;
  subtitle: string;
  label: string;
  children: ReactNode;
}

/**
 * The page: running header and footer as `thead`/`tfoot` (repeated per printed page), then the
 * title block and the identity table, then whatever the report puts on the sheet.
 */
export function ReportDocument({
  report,
  kicker,
  headline,
  title,
  subtitle,
  label,
  children,
}: ReportDocumentProps) {
  const identity = identityOf(report);

  return (
    <article className="industry rr" aria-label={label}>
      <table className="rr-page">
        <thead>
          <tr>
            <td>
              <header className="rr-header">
                <img src={logoUrl} alt="CareerLinkAI" />
                <div className="rr-header-body">
                  <div className="rr-header-title">{FRAME_COPY.headerTitle}</div>
                  <div className="rk">{kicker}</div>
                </div>
                <div className="mono rr-header-meta">
                  {headline}
                  <br />
                  {identity.completedShort}
                </div>
              </header>
            </td>
          </tr>
        </thead>

        <tfoot>
          <tr>
            <td>
              <footer className="rr-footer">
                <div className="rr-footer-copy">{FRAME_COPY.footer(new Date().getFullYear())}</div>
                <div className="mono rr-footer-mark">{FRAME_COPY.footerMark}</div>
              </footer>
            </td>
          </tr>
        </tfoot>

        <tbody>
          <tr>
            <td>
              <section className="rr-title">
                <div className="blueprint">
                  <Corners />
                  <img src={logoUrl} alt="" />
                </div>
                <div className="rr-title-body">
                  <div className="rk">{FRAME_COPY.exportKicker}</div>
                  <h1>{title}</h1>
                  <p>{subtitle}</p>
                </div>
              </section>

              <table className="rt rr-meta">
                <tbody>
                  <tr>
                    <th style={{ width: '16%' }}>Student</th>
                    <td className="rr-student" style={{ width: '34%' }}>
                      {identity.student}
                    </td>
                    <th style={{ width: '18%' }}>Date completed</th>
                    <td className="num rr-date" style={{ width: '32%' }}>
                      {identity.completedLong}
                    </td>
                  </tr>
                  <tr>
                    <th>Grade &amp; strand</th>
                    <td>{identity.gradeAndStrand}</td>
                    <th>Class / section</th>
                    <td className="num">{identity.className}</td>
                  </tr>
                  <tr>
                    <th>Counselor</th>
                    <td>{identity.counselor}</td>
                    <th>Instrument</th>
                    <td className="num">{identity.instrument}</td>
                  </tr>
                </tbody>
              </table>

              {children}
            </td>
          </tr>
        </tbody>
      </table>
    </article>
  );
}

/**
 * How many items took each point on the scale — all five points, named by the scale itself
 * (`AGREEMENT_SCALE`), including the ones no item landed on.
 */
export function LikertDistribution({ report }: { report: AssessmentReport }) {
  const tally = likertTally(report);

  return (
    <div>
      <div className="rk rr-subhead">{tally.heading}</div>
      <table className="rt">
        <thead>
          <tr>
            <th>Response</th>
            <th className="num">Value</th>
            <th className="num">Items</th>
            <th className="num">Share</th>
            <th style={{ width: '34%' }} />
          </tr>
        </thead>
        <tbody>
          {tally.rows.map((row) => (
            <tr key={row.value}>
              <td>{row.label}</td>
              <td className="num mono">{row.value}</td>
              <td className="num">{row.count}</td>
              <td className="num">{row.share}</td>
              <td>
                <div className="bar" aria-hidden="true">
                  <i style={{ width: `${row.fill * 100}%` }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BandsTable({ heading }: { heading: string }) {
  return (
    <div>
      <div className="rk rr-subhead">{heading}</div>
      <table className="rt">
        <thead>
          <tr>
            <th className="num" style={{ width: '26%' }}>
              Item mean
            </th>
            <th className="num" style={{ width: '30%' }}>
              Score
            </th>
            <th>Label</th>
          </tr>
        </thead>
        <tbody>
          {BAND_ROWS.map((band) => (
            <tr key={band.label}>
              <td className="num">{band.mean}</td>
              <td className="num">{band.score}</td>
              <td>{band.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Acknowledgement({ report, text }: { report: AssessmentReport; text: string }) {
  const identity = identityOf(report);
  const names = [identity.student, identity.counselorSignature, ''];

  return (
    <section className="panel rr-ack">
      <div className="rk">Acknowledgement</div>
      <p>{text}</p>
      <div className="rr-signatures">
        {SIGNATURE_LABELS.map((label, i) => (
          <div className="rr-signature" key={label}>
            <div className="rr-signature-label">{label}</div>
            <div className="rr-signature-name">{names[i]}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ItemAppendix({
  report,
  dims,
}: {
  report: AssessmentReport;
  dims: ReportDimension[];
}) {
  return (
    <section className="rr-appendix">
      <h2 className="sec">{APPENDIX_COPY.title}</h2>
      <p className="rk rr-lead">{APPENDIX_COPY.lead(report.instrument.question_count)}</p>
      {dims.map((dimension) => (
        <div className="rr-appendix-dim" key={dimension.code}>
          <div className="rr-appendix-head">
            <span className="mono rr-strong">{dimension.code}</span>
            <span className="rr-appendix-name">{dimension.name}</span>
            <span className="rr-fill" />
            <span className="mono rr-appendix-score">{appendixScore(dimension)}</span>
          </div>
          <table className="rt">
            <thead>
              <tr>
                <th className="num" style={{ width: '6%' }}>
                  #
                </th>
                <th>Item</th>
                <th style={{ width: '22%' }}>Response</th>
                <th className="num" style={{ width: '8%' }}>
                  Score
                </th>
              </tr>
            </thead>
            <tbody>
              {dimension.items.map((item) => (
                <tr key={item.order_number}>
                  <td className="num">{item.order_number}</td>
                  <td>{item.question_text}</td>
                  <td>{item.answer?.label ?? APPENDIX_COPY.notAnswered}</td>
                  <td className="num">{item.answer === null ? '—' : count(item.answer.score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
