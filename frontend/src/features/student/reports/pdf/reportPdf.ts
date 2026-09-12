import { jsPDF } from 'jspdf';

import { createPen, loadPdfAssets } from '@/features/student/reports/pdf/jspdfPen';
import {
  drawLine,
  layoutLines,
  lineHeightOf,
  render,
  stack,
  type Block,
  type BoxBlock,
  type Cell,
  type Column,
  type ColumnsBlock,
  type CustomBlock,
  type Pen,
  type Placeable,
  type Rgb,
  type TableBlock,
  type TableTheme,
  type TextBlock,
  type TextStyle,
} from '@/features/student/reports/pdf/layout';
import {
  APPENDIX_COPY,
  appendixScore,
  BAND_ROWS,
  CALCULATION_TITLE,
  FRAME_COPY,
  identityOf,
  inReportOrder,
  likertTally,
  riasecContent,
  scctContent,
  SIGNATURE_LABELS,
  type MatchRow,
  type ReportIdentity,
} from '@/features/student/reports/reportContent';
import { count, pct, type ReportDimension } from '@/features/student/reports/reportMath';
import type { AssessmentReport } from '@/types/assessment';
import type { RecommendationSet } from '@/types/recommendation';

/**
 * The downloaded PDF: the same one or two reports as the printed sheet, drawn with jsPDF so the
 * student gets a file without going through a print dialog.
 *
 * It follows the sheet section for section — the same words and figures (`reportContent`), the
 * same sizes, colours and faces (the Industry tokens, converted from CSS px), and the same break
 * rules (see `layout.ts`). Where the sheet and this file differ, the sheet is the reference.
 *
 * This module is only ever reached through `import()` — see `useReportDownload` — so jsPDF and
 * the fonts cost nothing until a student asks for a download.
 */

export interface ReportPdfOptions {
  /** The student's current set; drawn as the RIASEC report's "Top matches". */
  recommendations: RecommendationSet | null;
  showRecommendations: boolean;
  showAppendix: boolean;
}

/** CSS px → PDF pt. The mockups are specified in px at 96 to the inch. */
const px = (value: number) => value * 0.75;

const SPACE = {
  1: px(3.4),
  2: px(6.8),
  3: px(10.2),
  4: px(13.6),
  6: px(20.4),
  8: px(27.2),
} as const;

// industry.css. The translucent tokens are pre-mixed over white paper.
const INK: Rgb = [29, 31, 32];
const DIVIDER: Rgb = [219, 219, 219];
const ACCENT: Rgb = [89, 128, 166];
const ACCENT_100: Rgb = [238, 246, 255];
const ACCENT_700: Rgb = [65, 97, 128];
const ACCENT_800: Rgb = [44, 69, 93];
const NEUTRAL_200: Rgb = [231, 231, 234];
const NEUTRAL_700: Rgb = [93, 93, 96];
const NEUTRAL_800: Rgb = [66, 66, 68];
/** `.blueprint > .corner`: ink at 55%. */
const CORNER: Rgb = [131, 132, 132];

const HAIRLINE = px(1);

/** A4 with the sheet's 0.62in margins (report.css `@page`). */
const A4 = { width: 595.28, height: 841.89, margin: 0.62 * 72 };

function style(size: number, overrides: Partial<TextStyle> = {}): TextStyle {
  return { face: 'regular', size: px(size), color: INK, lineHeight: 1.55, ...overrides };
}

const KICKER = style(10.5, { face: 'condensed', color: ACCENT_700, tracking: 0.14, upper: true });
const HEADING: Partial<TextStyle> = { face: 'condensedBold', lineHeight: 1.12, tracking: -0.015 };

const MONO: Partial<TextStyle> = { face: 'mono' };
const MONO_STRONG: Partial<TextStyle> = { face: 'monoBold' };

const TABLE: TableTheme = {
  cell: style(10.5),
  head: style(9.5, { face: 'condensedBold', color: ACCENT_800, tracking: 0.06, upper: true }),
  sub: style(9, { color: NEUTRAL_700 }),
  padX: SPACE[2],
  padY: SPACE[1],
  rule: DIVIDER,
  headRule: INK,
  ruleWidth: HAIRLINE,
  bar: { height: px(7), track: NEUTRAL_200, fill: ACCENT, border: DIVIDER },
};

const PANEL_PADDING = { top: SPACE[3], right: SPACE[4], bottom: SPACE[3], left: SPACE[4] };

// --- Small builders -------------------------------------------------------------------------

function paragraph(text: string, textStyle: TextStyle, extra: Partial<TextBlock> = {}): TextBlock {
  return { kind: 'text', runs: [{ text }], style: textStyle, ...extra };
}

function kicker(text: string, extra: Partial<TextBlock> = {}): TextBlock {
  return paragraph(text, KICKER, extra);
}

/** `h2.sec` — with its rule — and the `.rr-lead` line under it; both stay with what follows. */
function sectionHeading(title: string, lead?: string, marginTop = 0): Block[] {
  const heading: TextBlock = {
    ...paragraph(title, style(19, HEADING)),
    rule: { gap: px(3), width: px(2), color: INK },
    marginTop,
    marginBottom: px(2),
    keepWithNext: true,
  };

  return lead ? [heading, kicker(lead, { marginBottom: SPACE[2], keepWithNext: true })] : [heading];
}

function panel(children: Block[]): BoxBlock {
  return { kind: 'box', border: DIVIDER, borderWidth: HAIRLINE, padding: PANEL_PADDING, children };
}

function cell(text: string, overrides: Partial<TextStyle> = {}): Cell {
  return { runs: [{ text }], style: overrides };
}

function headRow(labels: string[]): Cell[] {
  return labels.map((label) => ({ runs: label === '' ? [] : [{ text: label }], head: true }));
}

function table(columns: Column[], labels: string[], rows: Cell[][], extra: Partial<TableBlock> = {}): TableBlock {
  return {
    kind: 'table',
    theme: TABLE,
    columns,
    rows: [headRow(labels), ...rows],
    headerRows: 1,
    ...extra,
  };
}

/** The four registration marks `.blueprint` draws around a frame. */
function corners(pen: Pen, x: number, y: number, width: number, height: number): void {
  const arm = px(5.5);

  for (const [cx, cy] of [
    [x, y],
    [x + width, y],
    [x, y + height],
    [x + width, y + height],
  ] as const) {
    pen.line(cx - arm, cy, cx + arm, cy, CORNER, HAIRLINE);
    pen.line(cx, cy - arm, cx, cy + arm, CORNER, HAIRLINE);
  }
}

// --- The frame ------------------------------------------------------------------------------

/** `.rr-header`: logo, title and kicker, and the headline and date on the right. */
function runningHeader(pen: Pen, width: number, kickerText: string, headline: string, date: string): Placeable {
  const logo = px(26);
  const gap = SPACE[3];
  const meta = style(9.5, { face: 'mono', color: NEUTRAL_700, lineHeight: 1.3 });
  const metaLines = [headline, date].map(
    (line) => layoutLines(pen, [{ text: line }], meta, width)[0] ?? { words: [], width: 0, style: meta },
  );
  const metaWidth = Math.max(...metaLines.map((line) => line.width));
  const body = stack(
    pen,
    [
      paragraph(FRAME_COPY.headerTitle, style(13, { face: 'condensed', tracking: 0.04, upper: true, lineHeight: 1.1 })),
      kicker(kickerText),
    ],
    width - logo - 2 * gap - metaWidth,
  );
  const metaHeight = metaLines.length * lineHeightOf(meta);
  const inner = Math.max(logo, body.height, metaHeight);
  const height = inner + SPACE[2] + HAIRLINE + SPACE[4];

  return {
    height,
    draw(target, x, y) {
      target.logo(x, y + (inner - logo) / 2, logo, logo);
      body.draw(target, x + logo + gap, y + (inner - body.height) / 2);

      metaLines.forEach((line, i) => {
        const top = y + (inner - metaHeight) / 2 + i * lineHeightOf(meta);

        drawLine(target, line, x + width - metaWidth, top, metaWidth, 'right');
      });

      const rule = y + inner + SPACE[2] + HAIRLINE / 2;

      target.line(x, rule, x + width, rule, INK, HAIRLINE);
    },
  };
}

/** `.rr-footer`: the copyright line and CONFIDENTIAL, on a hairline. */
function runningFooter(pen: Pen, width: number): Placeable {
  const copyStyle = style(8.5, { color: NEUTRAL_700, lineHeight: 1.35 });
  const markStyle = style(8.5, { face: 'mono', color: NEUTRAL_700, lineHeight: 1.35, tracking: 0.08, upper: true });
  const mark = layoutLines(pen, [{ text: FRAME_COPY.footerMark }], markStyle, width)[0] ?? {
    words: [],
    width: 0,
    style: markStyle,
  };
  const copyWidth = width - mark.width - SPACE[4];
  const copy = layoutLines(pen, [{ text: FRAME_COPY.footer(new Date().getFullYear()) }], copyStyle, copyWidth);
  const content = copy.length * lineHeightOf(copyStyle);
  const offset = SPACE[4] + HAIRLINE + SPACE[2];

  return {
    height: offset + content,
    draw(target, x, y) {
      const rule = y + SPACE[4] + HAIRLINE / 2;

      target.line(x, rule, x + width, rule, DIVIDER, HAIRLINE);
      copy.forEach((line, i) => drawLine(target, line, x, y + offset + i * lineHeightOf(copyStyle), copyWidth, 'left'));
      drawLine(target, mark, x + width - mark.width, y + offset + content - lineHeightOf(markStyle), mark.width, 'right');
    },
  };
}

/** `.rr-title`: the framed logo, the kicker, the title and the subtitle. */
function titleBlock(title: string, subtitle: string): CustomBlock {
  return {
    kind: 'custom',
    marginBottom: SPACE[4],
    layout(pen, width) {
      const image = px(58);
      const pad = SPACE[3];
      const frame = image + 2 * pad;
      const gap = SPACE[4];
      const body = stack(
        pen,
        [
          kicker(FRAME_COPY.exportKicker),
          { ...paragraph(title, style(34, HEADING)), marginBottom: px(2) },
          paragraph(subtitle, style(11, { color: NEUTRAL_800 }), { widthFraction: 0.74 }),
        ],
        width - frame - gap,
      );

      return {
        height: Math.max(frame, body.height),
        draw(target, x, y) {
          target.rect(x, y, frame, frame, { stroke: DIVIDER, lineWidth: HAIRLINE });
          corners(target, x, y, frame, frame);
          target.logo(x + pad, y + pad, image, image);
          body.draw(target, x + frame + gap, y);
        },
      };
    },
  };
}

function identityTable(identity: ReportIdentity): TableBlock {
  const head = (label: string): Cell => ({ runs: [{ text: label }], head: true });
  const num = (value: string, size = 10.5): Cell => ({
    runs: [{ text: value }],
    align: 'right',
    style: { face: 'mono', size: px(size) },
  });

  return {
    kind: 'table',
    theme: TABLE,
    columns: [{ width: 0.16 }, { width: 0.34 }, { width: 0.18 }, { width: 0.32 }],
    rows: [
      [head('Student'), cell(identity.student, { size: px(12) }), head('Date completed'), num(identity.completedLong, 11)],
      [head('Grade & strand'), cell(identity.gradeAndStrand), head('Class / section'), num(identity.className)],
      [head('Counselor'), cell(identity.counselor), head('Instrument'), num(identity.instrument)],
    ],
    marginBottom: SPACE[4],
  };
}

interface HeroCode {
  kicker: string;
  value: string;
  /** The Holland Code's wide letter spacing. */
  spaced?: boolean;
  sub?: string;
}

/** `.rr-hero`: the tinted panel with the headline figure, a rule, and what it means. */
function hero(code: HeroCode, body: Block[]): BoxBlock {
  const row: CustomBlock = {
    kind: 'custom',
    layout(pen, width) {
      const value = style(46, { face: 'monoBold', lineHeight: 1.05, ...(code.spaced ? { tracking: 0.18 } : {}) });
      const sub = style(10, { face: 'mono', color: NEUTRAL_700 });
      const natural = Math.max(
        pen.width(code.kicker.toUpperCase(), KICKER),
        pen.width(code.value, value),
        code.sub ? pen.width(code.sub, sub) : 0,
      );
      const codeWidth = Math.min(natural + 1, width * 0.45);
      const left = stack(
        pen,
        [
          kicker(code.kicker, { align: 'center' }),
          paragraph(code.value, value, { align: 'center' }),
          ...(code.sub ? [paragraph(code.sub, sub, { align: 'center' })] : []),
        ],
        codeWidth,
      );
      const gutter = SPACE[6];
      const right = stack(pen, body, width - codeWidth - 2 * gutter - HAIRLINE);
      const height = Math.max(left.height, right.height);

      return {
        height,
        draw(target, x, y) {
          const leftTop = y + (height - left.height) / 2;
          const rule = x + codeWidth + gutter + HAIRLINE / 2;

          left.draw(target, x, leftTop);
          target.line(rule, leftTop, rule, leftTop + left.height, DIVIDER, HAIRLINE);
          right.draw(target, x + codeWidth + 2 * gutter + HAIRLINE, y + (height - right.height) / 2);
        },
      };
    },
  };

  return {
    kind: 'box',
    keepTogether: true,
    fill: ACCENT_100,
    border: DIVIDER,
    borderWidth: HAIRLINE,
    padding: PANEL_PADDING,
    marginBottom: SPACE[4],
    children: [row],
  };
}

function heroNote(text: string): TextBlock {
  return paragraph(text, style(10.5, { color: NEUTRAL_800 }), { marginTop: SPACE[1] });
}

function calculation(left: Block[], right: Block[], weights: [number, number]): ColumnsBlock {
  return {
    kind: 'columns',
    gap: SPACE[3],
    stretch: true,
    marginTop: SPACE[2],
    marginBottom: SPACE[4],
    columns: [
      { weight: weights[0], children: [panel(left)] },
      { weight: weights[1], children: [panel(right)] },
    ],
  };
}

function normalizationPanel(normalization: {
  kicker: string;
  formula: string;
  note: string;
  example: string | null;
}): Block[] {
  return [
    kicker(normalization.kicker),
    paragraph(normalization.formula, style(13, MONO), { marginTop: SPACE[2], marginBottom: SPACE[2] }),
    paragraph(normalization.note, style(10)),
    ...(normalization.example
      ? [paragraph(normalization.example, style(10.5, MONO), { marginTop: SPACE[2] })]
      : []),
  ];
}

function breakdownBar(dimension: ReportDimension): Cell {
  return { runs: [], bar: dimension.pct };
}

/** The Likert tally beside the bands table (`.rr-grid-dist`). */
function distribution(report: AssessmentReport, bandsHeading: string): ColumnsBlock {
  const tally = likertTally(report);
  const right = { align: 'right' } as const;

  return {
    kind: 'columns',
    gap: SPACE[3],
    marginBottom: SPACE[6],
    columns: [
      {
        weight: 1.15,
        children: [
          kicker(tally.heading, { marginBottom: SPACE[2], keepWithNext: true }),
          table(
            [{ width: 0.3 }, { width: 0.12, ...right }, { width: 0.12, ...right }, { width: 0.14, ...right }, { width: 0.32 }],
            ['Response', 'Value', 'Items', 'Share', ''],
            tally.rows.map((row) => [
              cell(row.label),
              cell(String(row.value), MONO),
              cell(String(row.count), MONO),
              cell(row.share, MONO),
              { runs: [], bar: row.fill * 100 },
            ]),
          ),
        ],
      },
      {
        weight: 1,
        children: [
          kicker(bandsHeading, { marginBottom: SPACE[2], keepWithNext: true }),
          // Wider than the sheet's 26% / 30%: IBM Plex Mono sets "1.00 – 1.79" wider than the
          // browser's monospace, and a wrapped range reads as two numbers.
          table(
            [{ width: 0.3, ...right }, { width: 0.34, ...right }, {}],
            ['Item mean', 'Score', 'Label'],
            BAND_ROWS.map((band) => [cell(band.mean, MONO), cell(band.score, MONO), cell(band.label)]),
          ),
        ],
      },
    ],
  };
}

function matchTable(heading: string, noun: string, rows: MatchRow[]): Block[] {
  const right = { align: 'right' } as const;

  return [
    kicker(heading, { style: { ...KICKER, face: 'condensedBold' }, marginBottom: SPACE[2], keepWithNext: true }),
    table(
      [{ width: 0.1, ...right }, {}, { width: 0.15, ...right }, { width: 0.17, ...right }],
      ['#', noun, 'Code', 'Match'],
      rows.length === 0
        ? [[{ runs: [{ text: 'None yet.' }], span: 4 }]]
        : rows.map((row) => [
            cell(String(row.rank), MONO),
            { runs: [{ text: row.title }], style: { face: 'medium' }, sub: row.reason },
            cell(row.code, MONO),
            cell(row.match, MONO_STRONG),
          ]),
    ),
  ];
}

/** `.rr-ack`: splits between its paragraph and the signature row if it must, never inside the row. */
function acknowledgement(identity: ReportIdentity, text: string): BoxBlock {
  const names = [identity.student, identity.counselorSignature, ''];

  return {
    ...panel([
      kicker('Acknowledgement', { keepWithNext: true }),
      paragraph(text, style(10), { marginTop: SPACE[2], marginBottom: SPACE[3] }),
      {
        kind: 'columns',
        gap: SPACE[6],
        marginTop: SPACE[8],
        columns: SIGNATURE_LABELS.map((label, i) => ({
          weight: 1,
          children: [
            { kind: 'rule', color: INK, width: HAIRLINE },
            paragraph(label, style(10, { face: 'medium' }), { marginTop: SPACE[1] }),
            paragraph(names[i] ?? '', style(9, { color: NEUTRAL_700 })),
          ],
        })),
      },
    ]),
    marginBottom: SPACE[1],
  };
}

/** `.rr-appendix-head`: code, name, and the dimension's score, on one baseline over a rule. */
function appendixHead(dimension: ReportDimension): CustomBlock {
  return {
    kind: 'custom',
    keepWithNext: true,
    marginBottom: SPACE[1],
    layout(pen, width) {
      const code = style(15, { face: 'monoBold' });
      const name = style(15, { face: 'condensed', tracking: 0.05 });
      const score = style(10, { face: 'mono' });
      const line = lineHeightOf(code);
      const { ascent, descent } = pen.metrics(code.face);
      const baselineOffset = (line - (ascent + descent) * code.size) / 2 + ascent * code.size;
      const codeWidth = pen.width(dimension.code, code);
      const scoreText = appendixScore(dimension);
      const scoreWidth = pen.width(scoreText, score);
      const height = line + px(2) + HAIRLINE;

      return {
        height,
        draw(target, x, y) {
          const baseline = y + baselineOffset;

          target.text(dimension.code, x, baseline, code);
          target.text(dimension.name.toUpperCase(), x + codeWidth + SPACE[2], baseline, name);
          target.text(scoreText, x + width - scoreWidth, baseline, score);
          target.line(x, y + height - HAIRLINE / 2, x + width, y + height - HAIRLINE / 2, INK, HAIRLINE);
        },
      };
    },
  };
}

function appendix(report: AssessmentReport, dims: ReportDimension[]): Block[] {
  const right = { align: 'right' } as const;

  return [
    ...sectionHeading(APPENDIX_COPY.title, APPENDIX_COPY.lead(report.instrument.question_count), SPACE[6]),
    ...dims.flatMap((dimension): Block[] => [
      appendixHead(dimension),
      table(
        [{ width: 0.06, ...right }, {}, { width: 0.22 }, { width: 0.08, ...right }],
        ['#', 'Item', 'Response', 'Score'],
        dimension.items.map((item) => [
          cell(String(item.order_number), MONO),
          cell(item.question_text),
          cell(item.answer?.label ?? APPENDIX_COPY.notAnswered),
          cell(item.answer === null ? '—' : count(item.answer.score), MONO),
        ]),
        { marginBottom: SPACE[3] },
      ),
    ]),
    paragraph(APPENDIX_COPY.fine, style(9.5, { color: NEUTRAL_700 })),
  ];
}

// --- The two reports ------------------------------------------------------------------------

interface ReportSection {
  title: string;
  kicker: string;
  headline: string;
  date: string;
  blocks: Block[];
}

function riasecSection(report: AssessmentReport, options: ReportPdfOptions): ReportSection {
  const content = riasecContent(report, options.recommendations);
  const identity = identityOf(report);
  const { dims, normalization, tieBreak, matches } = content;
  const right = { align: 'right' } as const;

  const breakdown = table(
    [
      { width: 0.06 },
      { width: 0.22 },
      { width: 0.07, ...right },
      { width: 0.07, ...right },
      { width: 0.08, ...right },
      { width: 0.08, ...right },
      { width: 0.22 },
      { width: 0.2 },
    ],
    ['Code', 'Dimension', 'Raw', 'Max', 'Score', 'Mean', 'Distribution', 'Band'],
    dims.map((dimension) => [
      cell(dimension.code, MONO_STRONG),
      cell(dimension.name, { face: 'medium' }),
      cell(count(dimension.raw), MONO),
      cell(count(dimension.max), MONO),
      cell(pct(dimension.pct), MONO_STRONG),
      cell(dimension.mean.toFixed(2), MONO),
      breakdownBar(dimension),
      cell(dimension.band),
    ]),
    { marginBottom: SPACE[4] },
  );

  return {
    title: content.title,
    kicker: content.kicker,
    headline: content.headline,
    date: identity.completedShort,
    blocks: [
      titleBlock(content.title, content.subtitle),
      identityTable(identity),
      hero({ kicker: content.heroKicker, value: content.holland, spaced: true }, [
        paragraph(content.topThree, style(17, { face: 'condensed', lineHeight: 1.2 })),
        heroNote(content.heroNote),
      ]),
      ...sectionHeading(content.breakdownTitle, content.breakdownLead),
      breakdown,
      ...sectionHeading(CALCULATION_TITLE),
      calculation(
        normalizationPanel(normalization),
        [
          kicker(tieBreak.kicker),
          paragraph(tieBreak.note, style(10)),
          ...(tieBreak.example ? [paragraph(tieBreak.example, style(10.5, MONO), { marginTop: SPACE[2] })] : []),
        ],
        [1, 1],
      ),
      distribution(report, content.bandsHeading),
      ...(options.showRecommendations && matches.any
        ? [
            ...sectionHeading(matches.title, matches.lead),
            {
              kind: 'columns',
              gap: SPACE[4],
              marginBottom: SPACE[4],
              columns: [
                { weight: 1, children: matchTable('Program recommendations', 'Program', matches.programs) },
                { weight: 1, children: matchTable('Career recommendations', 'Career', matches.careers) },
              ],
            } satisfies ColumnsBlock,
          ]
        : []),
      acknowledgement(identity, content.acknowledgement),
      ...(options.showAppendix ? appendix(report, dims) : []),
    ],
  };
}

function scctSection(report: AssessmentReport, options: ReportPdfOptions): ReportSection {
  const content = scctContent(report);
  const identity = identityOf(report);
  const { dims, normalization, composite } = content;
  const right = { align: 'right' } as const;
  const formula = style(11, { ...MONO, lineHeight: 1.7 });
  const indent = '\u00a0\u00a0';

  const breakdown = table(
    [
      { width: 0.06 },
      { width: 0.23 },
      { width: 0.07, ...right },
      { width: 0.07, ...right },
      { width: 0.08, ...right },
      { width: 0.08, ...right },
      { width: 0.18 },
      { width: 0.08, ...right },
      { width: 0.15 },
    ],
    ['Code', 'Construct', 'Raw', 'Max', 'Score', 'Mean', 'Distribution', 'Weight', 'Band'],
    dims.map((dimension) => [
      cell(dimension.code, MONO_STRONG),
      {
        runs: [{ text: dimension.name }],
        style: { face: 'medium' },
        ...(dimension.description ? { sub: dimension.description } : {}),
      },
      cell(count(dimension.raw), MONO),
      cell(count(dimension.max), MONO),
      cell(pct(dimension.pct), MONO_STRONG),
      cell(dimension.mean.toFixed(2), MONO),
      breakdownBar(dimension),
      cell(dimension.weight === null ? '—' : dimension.weight.toFixed(2), MONO),
      cell(dimension.band),
    ]),
    { marginBottom: SPACE[4] },
  );

  return {
    title: content.title,
    kicker: content.kicker,
    headline: content.headline,
    date: identity.completedShort,
    blocks: [
      titleBlock(content.title, content.subtitle),
      identityTable(identity),
      hero({ kicker: content.heroKicker, value: content.index, sub: content.meanLine }, [
        paragraph(content.summary, style(19, { face: 'condensed', lineHeight: 1.2 })),
        heroNote(content.heroNote),
      ]),
      ...sectionHeading(content.breakdownTitle, content.breakdownLead),
      breakdown,
      ...sectionHeading(CALCULATION_TITLE),
      calculation(
        normalizationPanel(normalization),
        [
          kicker(composite.kicker),
          paragraph(composite.formula, formula, { marginTop: SPACE[2] }),
          paragraph(`${indent}= ${composite.terms}`, formula),
          paragraph(`${indent}= ${composite.products}`, formula),
          {
            kind: 'text',
            runs: [{ text: `${indent}${composite.divisor} ` }, { text: content.index, style: MONO_STRONG }],
            style: formula,
          },
          paragraph(composite.fine, style(9.5, { color: NEUTRAL_700 })),
        ],
        [1, 1.25],
      ),
      distribution(report, content.bandsHeading),
      acknowledgement(identity, content.acknowledgement),
      ...(options.showAppendix ? appendix(report, dims) : []),
    ],
  };
}

// --- The file -------------------------------------------------------------------------------

/** "CareerLinkAI-Results-Maria-Louise-A-Fernandez.pdf" — ASCII only, so every OS keeps it. */
export function reportFileName(reports: AssessmentReport[]): string {
  const first = reports[0];
  const kind =
    reports.length > 1 ? 'Results' : `${first?.assessment?.category ?? 'Assessment'}-Report`;
  const student = (first?.student.name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `CareerLinkAI-${kind}${student ? `-${student}` : ''}.pdf`;
}

export async function createReportsPdf(
  reports: AssessmentReport[],
  options: ReportPdfOptions,
): Promise<{ blob: Blob; filename: string; pages: number }> {
  const ordered = inReportOrder(reports);
  const first = ordered[0];

  if (first === undefined) throw new Error('There is no RIASEC or SCCT report to put in the PDF.');

  const assets = await loadPdfAssets();
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true, putOnlyUsedFonts: true });
  const pen = createPen(doc, assets);
  const width = A4.width - 2 * A4.margin;

  const sections = ordered.map((report) =>
    report.assessment?.category === 'RIASEC' ? riasecSection(report, options) : scctSection(report, options),
  );
  const headers = sections.map((section) =>
    runningHeader(pen, width, section.kicker, section.headline, section.date),
  );
  const fallbackHeader = headers[0] ?? runningHeader(pen, width, '', '', '');

  const pages = render(pen, {
    page: A4,
    header: (section) => headers[section] ?? fallbackHeader,
    footer: runningFooter(pen, width),
    sectionGap: SPACE[8],
    sections: sections.map((section) => section.blocks),
  });

  doc.setProperties({
    title: `${ordered.length > 1 ? 'Assessment results' : (sections[0]?.title ?? 'Assessment report')} — ${first.student.name}`,
    subject: FRAME_COPY.headerTitle,
    author: 'CareerLinkAI',
    creator: 'CareerLinkAI',
  });

  return { blob: doc.output('blob'), filename: reportFileName(ordered), pages };
}

/** Hands the browser a file. The object URL outlives the click: some browsers start late. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadReportsPdf(
  reports: AssessmentReport[],
  options: ReportPdfOptions,
): Promise<void> {
  const { blob, filename } = await createReportsPdf(reports, options);

  saveBlob(blob, filename);
}
