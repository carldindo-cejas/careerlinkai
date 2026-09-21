/**
 * The typesetter behind the downloaded report PDF: blocks in, pages out.
 *
 * The printed sheet leaves pagination to the browser; a PDF built with jsPDF has no browser to lean
 * on, so this does that part. It is deliberately small — the reports need flowing text, tables
 * whose header repeats on every page they cross, bordered panels, side-by-side columns and a
 * running header and footer, and nothing else.
 *
 * It follows the same break rules as the print stylesheet (report.css), so the PDF and the paper
 * copy break alike: content flows continuously and nothing is pushed to a fresh page wholesale.
 * The only things that travel together are small — one table row, one line of text, a paragraph
 * of three lines or fewer, a heading with what follows it, and blocks marked `keepTogether` — so
 * the blank space a page can end on is bounded by the largest of those, never half a sheet.
 *
 * Drawing goes through `Pen`, so the pagination is tested against a fake with fixed-width glyphs
 * and the real one (jsPDF) lives in `jspdfPen.ts`. All lengths are PDF points.
 */

export type Rgb = readonly [number, number, number];

export type Face =
  | 'regular'
  | 'medium'
  | 'bold'
  | 'condensed'
  | 'condensedBold'
  | 'mono'
  | 'monoBold';

export interface TextStyle {
  face: Face;
  size: number;
  color: Rgb;
  /** The line box, as a multiple of `size` — CSS `line-height`. */
  lineHeight: number;
  /** In em — CSS `letter-spacing`. */
  tracking?: number;
  upper?: boolean;
}

/** A piece of text in its own style, e.g. the bold index at the end of the composite line. */
export interface Run {
  text: string;
  style?: Partial<TextStyle>;
}

export interface Paint {
  fill?: Rgb;
  stroke?: Rgb;
  lineWidth?: number;
}

export interface Pen {
  /** A face's ascent and descent, in em. */
  metrics(face: Face): { ascent: number; descent: number };
  /** The advance width of `text`, letter spacing included between (not after) characters. */
  width(text: string, style: TextStyle): number;
  /** `baseline` is the alphabetic baseline. */
  text(text: string, x: number, baseline: number, style: TextStyle): void;
  rect(x: number, y: number, width: number, height: number, paint: Paint): void;
  line(x1: number, y1: number, x2: number, y2: number, color: Rgb, width: number): void;
  /** The CareerLinkAI logo — the only image the reports carry. */
  logo(x: number, y: number, width: number, height: number): void;
  addPage(): void;
}

export type Align = 'left' | 'right' | 'center';

// --- Text -----------------------------------------------------------------------------------

interface Word {
  text: string;
  style: TextStyle;
  /** Preceded by a space in the source (ignored at the start of a line). */
  space: boolean;
}

export interface TextLine {
  words: Word[];
  width: number;
  style: TextStyle;
}

function trackingOf(style: TextStyle): number {
  return (style.tracking ?? 0) * style.size;
}

export function lineHeightOf(style: TextStyle): number {
  return style.size * style.lineHeight;
}

function advance(pen: Pen, word: Word): number {
  return pen.width(word.text, word.style) + trackingOf(word.style);
}

function spaceAdvance(pen: Pen, style: TextStyle): number {
  return pen.width(' ', style) + trackingOf(style);
}

function wordsOf(runs: Run[], base: TextStyle): Word[] {
  const words: Word[] = [];
  let space = false;

  for (const run of runs) {
    const style: TextStyle = { ...base, ...run.style };
    const text = style.upper ? run.text.toUpperCase() : run.text;

    text.split(' ').forEach((part, index) => {
      if (index > 0) space = true;
      if (part === '') return;

      words.push({ text: part, style, space: space && words.length > 0 });
      space = false;
    });
  }

  return words;
}

/** A word wider than the whole line is cut where it has to be, rather than running off the page. */
function piecesOf(pen: Pen, word: Word, maxWidth: number): Word[] {
  if (advance(pen, word) <= maxWidth) return [word];

  const pieces: Word[] = [];
  let rest = [...word.text];
  let space = word.space;

  while (rest.length > 0) {
    let take = rest.length;

    while (take > 1 && pen.width(rest.slice(0, take).join(''), word.style) > maxWidth) take -= 1;

    pieces.push({ text: rest.slice(0, take).join(''), style: word.style, space });
    rest = rest.slice(take);
    space = false;
  }

  return pieces;
}

/** Greedy word wrap. Always at least one line, so an empty cell still has its line box. */
export function layoutLines(pen: Pen, runs: Run[], base: TextStyle, maxWidth: number): TextLine[] {
  const lines: TextLine[] = [];
  let words: Word[] = [];
  let width = 0;

  const close = () => {
    const last = words[words.length - 1];

    lines.push({ words, width: last ? width - trackingOf(last.style) : 0, style: base });
    words = [];
    width = 0;
  };

  for (const source of wordsOf(runs, base)) {
    for (const word of piecesOf(pen, source, maxWidth)) {
      const gap = words.length > 0 && word.space ? spaceAdvance(pen, word.style) : 0;
      const size = advance(pen, word);

      if (words.length > 0 && width + gap + size - trackingOf(word.style) > maxWidth) {
        close();
        words.push({ ...word, space: false });
        width = size;
      } else {
        words.push(words.length === 0 ? { ...word, space: false } : word);
        width += gap + size;
      }
    }
  }

  if (words.length > 0 || lines.length === 0) close();

  return lines;
}

/** Top of the line box in, baseline out — the CSS half-leading model. */
function baselineOf(pen: Pen, style: TextStyle, top: number): number {
  const { ascent, descent } = pen.metrics(style.face);

  return (
    top + (lineHeightOf(style) - (ascent + descent) * style.size) / 2 + ascent * style.size
  );
}

export function drawLine(
  pen: Pen,
  line: TextLine,
  x: number,
  top: number,
  maxWidth: number,
  align: Align,
): void {
  const baseline = baselineOf(pen, line.style, top);
  let cursor =
    x +
    (align === 'right'
      ? maxWidth - line.width
      : align === 'center'
        ? (maxWidth - line.width) / 2
        : 0);

  line.words.forEach((word, index) => {
    if (index > 0 && word.space) cursor += spaceAdvance(pen, word.style);
    pen.text(word.text, cursor, baseline, word.style);
    cursor += advance(pen, word);
  });
}

// --- Blocks ---------------------------------------------------------------------------------

interface Spacing {
  /** Adjacent margins collapse to the larger, as in CSS; a margin at the top of a page is dropped. */
  marginTop?: number;
  marginBottom?: number;
  /** Never the last thing on a page — a heading, a lead-in line. */
  keepWithNext?: boolean;
}

export interface TextBlock extends Spacing {
  kind: 'text';
  runs: Run[];
  style: TextStyle;
  align?: Align;
  /** Narrower than the flow, as a fraction of it (the title block's 74%). */
  widthFraction?: number;
  /** A rule under the last line — `h2.sec`'s border-bottom. */
  rule?: { gap: number; width: number; color: Rgb };
}

export interface Column {
  /** A fraction of the table's width; columns without one share what is left. */
  width?: number;
  align?: Align;
}

export interface Cell {
  runs: Run[];
  style?: Partial<TextStyle>;
  align?: Align;
  /** A `th`: the header face, and the ink rule under it instead of the hairline. */
  head?: boolean;
  /** A second, smaller line — the reason under a match, the description under a construct. */
  sub?: string;
  /** A distribution bar, 0–100. */
  bar?: number;
  /** Columns this cell spans. */
  span?: number;
}

export interface TableTheme {
  cell: TextStyle;
  head: TextStyle;
  sub: TextStyle;
  padX: number;
  padY: number;
  rule: Rgb;
  headRule: Rgb;
  ruleWidth: number;
  bar: { height: number; track: Rgb; fill: Rgb; border: Rgb };
}

export interface TableBlock extends Spacing {
  kind: 'table';
  columns: Column[];
  rows: Cell[][];
  /** Leading rows that form the header — repeated at the top of every page the table crosses. */
  headerRows?: number;
  theme: TableTheme;
}

export interface BoxBlock extends Spacing {
  kind: 'box';
  children: Block[];
  padding: { top: number; right: number; bottom: number; left: number };
  border?: Rgb;
  borderWidth?: number;
  fill?: Rgb;
  /** Never split across pages. Only for compact panels whose halves would mean nothing apart. */
  keepTogether?: boolean;
  /** Grid stretch: the height a column gives a box it holds alone. */
  minHeight?: number;
}

/**
 * Side-by-side columns, CSS-grid style. Columns of plain flow (tables, text) break where all of
 * them can — between rows that line up — so a pair of tables never waits for a fresh page. Columns
 * holding a box, or stretched, stay whole: those are the calculation panels, a few lines tall.
 */
export interface ColumnsBlock extends Spacing {
  kind: 'columns';
  gap: number;
  columns: { weight: number; children: Block[] }[];
  /** `align-items: stretch`: a box that is a column's only child grows to the row's height. */
  stretch?: boolean;
  /**
   * Never split across pages, as `break-inside: avoid` on the sheet. Only for a row short enough
   * that the white it can push to the next page is worth less than the split — the distribution
   * beside the bands table, whose second half would arrive with no heading over it.
   */
  keepTogether?: boolean;
}

export interface RuleBlock extends Spacing {
  kind: 'rule';
  color: Rgb;
  width: number;
}

export interface Placeable {
  height: number;
  draw(pen: Pen, x: number, y: number): void;
}

/** Anything drawn by hand — the title block, the hero, an appendix heading. Kept together. */
export interface CustomBlock extends Spacing {
  kind: 'custom';
  layout(pen: Pen, width: number): Placeable;
}

export type Block = TextBlock | TableBlock | BoxBlock | ColumnsBlock | RuleBlock | CustomBlock;

// --- Slices: the atoms a page break may fall between ----------------------------------------

/** A breakable box, as its slices see it. `x` is relative to the flow the box sits in. */
interface Frame {
  box: BoxBlock;
  x: number;
  width: number;
}

interface Slice {
  height: number;
  /** Space above; dropped when the slice opens a page. */
  gap: number;
  keepWithNext: boolean;
  /** Header rows to redraw when this table row is the first thing on a page. */
  repeat?: Slice[];
  /** The top or bottom edge of a breakable box. */
  opens?: Frame;
  closes?: Frame;
  section: number;
  /** The inline header of a report that begins partway down a page. */
  sectionStart?: boolean;
  draw(pen: Pen, dx: number, y: number): void;
}

function slice(height: number, draw: Slice['draw'] = () => {}): Slice {
  return { height, gap: 0, keepWithNext: false, section: 0, draw };
}

function flatten(
  pen: Pen,
  blocks: Block[],
  x: number,
  width: number,
): { slices: Slice[]; trailing: number } {
  const slices: Slice[] = [];
  let previousBottom: number | null = null;

  for (const block of blocks) {
    const own = sliceBlock(pen, block, x, width);
    const first = own[0];
    const last = own[own.length - 1];

    if (first === undefined || last === undefined) continue;

    const top = block.marginTop ?? 0;

    first.gap += previousBottom === null ? top : Math.max(previousBottom, top);
    if (block.keepWithNext) last.keepWithNext = true;

    slices.push(...own);
    previousBottom = block.marginBottom ?? 0;
  }

  return { slices, trailing: previousBottom ?? 0 };
}

function sliceBlock(pen: Pen, block: Block, x: number, width: number): Slice[] {
  switch (block.kind) {
    case 'text':
      return textSlices(pen, block, x, width);
    case 'table':
      return tableSlices(pen, block, x, width);
    case 'box':
      return block.keepTogether ? [atomic(boxPlaceable(pen, block, width), x)] : boxSlices(pen, block, x, width);
    case 'columns':
      return block.keepTogether
        ? [atomic(columnsPlaceable(pen, block, width), x)]
        : columnsSlices(pen, block, x, width);
    case 'rule':
      return [
        slice(block.width, (target, dx, y) =>
          target.line(dx + x, y + block.width / 2, dx + x + width, y + block.width / 2, block.color, block.width),
        ),
      ];
    case 'custom':
      return [atomic(block.layout(pen, width), x)];
  }
}

function atomic(placeable: Placeable, x: number): Slice {
  return slice(placeable.height, (pen, dx, y) => placeable.draw(pen, dx + x, y));
}

function textSlices(pen: Pen, block: TextBlock, x: number, width: number): Slice[] {
  const lineWidth = width * (block.widthFraction ?? 1);
  const lines = layoutLines(pen, block.runs, block.style, lineWidth);
  const height = lineHeightOf(block.style);
  const slices = lines.map((line) =>
    slice(height, (target, dx, y) => drawLine(target, line, dx + x, y, lineWidth, block.align ?? 'left')),
  );

  // No orphans and no widows: a paragraph never leaves a single line alone at the foot of one page
  // or the head of the next. Three lines or fewer therefore always travel together.
  const first = slices[0];
  const penultimate = slices[slices.length - 2];

  if (first && penultimate) {
    first.keepWithNext = true;
    penultimate.keepWithNext = true;
  }

  const { rule } = block;
  const last = slices[slices.length - 1];

  if (rule && last) {
    last.keepWithNext = true;
    slices.push(
      slice(rule.gap + rule.width, (target, dx, y) => {
        const at = y + rule.gap + rule.width / 2;

        target.line(dx + x, at, dx + x + width, at, rule.color, rule.width);
      }),
    );
  }

  return slices;
}

function columnWidths(columns: Column[], width: number): number[] {
  const fixed = columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
  const flexible = columns.filter((column) => column.width === undefined).length;
  const share = flexible === 0 ? 0 : Math.max(0, 1 - fixed) / flexible;

  return columns.map((column) => (column.width ?? share) * width);
}

function tableRow(pen: Pen, table: TableBlock, cells: Cell[], widths: number[]): Placeable {
  const { theme } = table;
  let column = 0;

  const laid = cells.map((cell) => {
    const span = cell.span ?? 1;
    const x = widths.slice(0, column).reduce((sum, w) => sum + w, 0);
    const width = widths.slice(column, column + span).reduce((sum, w) => sum + w, 0);
    const align = cell.align ?? table.columns[column]?.align ?? 'left';

    column += span;

    const style: TextStyle = { ...(cell.head ? theme.head : theme.cell), ...cell.style };
    const inner = width - 2 * theme.padX;
    const lines = cell.runs.length > 0 ? layoutLines(pen, cell.runs, style, inner) : [];
    const sub = cell.sub ? layoutLines(pen, [{ text: cell.sub }], theme.sub, inner) : [];
    const height = lines.length * lineHeightOf(style) + sub.length * lineHeightOf(theme.sub);

    return { cell, style, lines, sub, x, width, inner, align, height };
  });

  const content = Math.max(lineHeightOf(theme.cell), ...laid.map((cell) => cell.height));
  const height = content + 2 * theme.padY + theme.ruleWidth;

  return {
    height,
    draw(target, x, y) {
      for (const cell of laid) {
        const left = x + cell.x + theme.padX;
        let top = y + theme.padY;

        if (cell.cell.bar !== undefined) {
          const { bar } = theme;
          const barTop = top + (lineHeightOf(theme.cell) - bar.height) / 2;
          const fill = Math.min(100, Math.max(0, cell.cell.bar)) / 100;

          target.rect(left, barTop, cell.inner, bar.height, { fill: bar.track });
          if (fill > 0) target.rect(left, barTop, cell.inner * fill, bar.height, { fill: bar.fill });
          target.rect(left, barTop, cell.inner, bar.height, { stroke: bar.border, lineWidth: theme.ruleWidth });
        }

        for (const line of cell.lines) {
          drawLine(target, line, left, top, cell.inner, cell.align);
          top += lineHeightOf(cell.style);
        }

        for (const line of cell.sub) {
          drawLine(target, line, left, top, cell.inner, cell.align);
          top += lineHeightOf(theme.sub);
        }

        const rule = y + height - theme.ruleWidth / 2;

        target.line(
          x + cell.x,
          rule,
          x + cell.x + cell.width,
          rule,
          cell.cell.head ? theme.headRule : theme.rule,
          theme.ruleWidth,
        );
      }
    },
  };
}

function tableSlices(pen: Pen, table: TableBlock, x: number, width: number): Slice[] {
  const widths = columnWidths(table.columns, width);
  const headerCount = table.headerRows ?? 0;
  const rows = table.rows.map((cells) => atomic(tableRow(pen, table, cells, widths), x));
  const header = rows.slice(0, headerCount);

  // A header is never the last thing on a page: it goes over with the first row under it.
  for (const row of header) row.keepWithNext = true;

  const body = rows.slice(headerCount).map((row) => (header.length > 0 ? { ...row, repeat: header } : row));

  return [...header, ...body];
}

function boxSlices(pen: Pen, box: BoxBlock, x: number, width: number): Slice[] {
  const border = box.borderWidth ?? (box.border ? 0.75 : 0);
  const frame: Frame = { box, x, width };
  const inner = flatten(
    pen,
    box.children,
    x + border + box.padding.left,
    width - 2 * border - box.padding.left - box.padding.right,
  );

  const open: Slice = { ...slice(border + box.padding.top), keepWithNext: true, opens: frame };
  const close: Slice = { ...slice(inner.trailing + box.padding.bottom + border), closes: frame };
  const last = inner.slices[inner.slices.length - 1];

  // The bottom edge never starts a page on its own.
  if (last) last.keepWithNext = true;

  return [open, ...inner.slices, close];
}

// --- Laying out without page breaks (columns, kept-together boxes) --------------------------

interface Segment {
  frame: Frame;
  top: number;
  bottom: number;
  /** Continued from the previous page — no top edge. */
  openTop: boolean;
  /** Continues on the next page — no bottom edge. */
  openBottom: boolean;
}

function paintFill(pen: Pen, segment: Segment, dx: number): void {
  const { box } = segment.frame;

  if (box.fill) {
    pen.rect(dx + segment.frame.x, segment.top, segment.frame.width, segment.bottom - segment.top, {
      fill: box.fill,
    });
  }
}

function paintBorder(pen: Pen, segment: Segment, dx: number): void {
  const { box, x, width } = segment.frame;

  if (!box.border) return;

  const w = box.borderWidth ?? 0.75;
  const left = dx + x;
  const right = dx + x + width;
  const top = segment.top;
  const bottom = segment.bottom;

  pen.line(left + w / 2, top, left + w / 2, bottom, box.border, w);
  pen.line(right - w / 2, top, right - w / 2, bottom, box.border, w);
  if (!segment.openTop) pen.line(left, top + w / 2, right, top + w / 2, box.border, w);
  if (!segment.openBottom) pen.line(left, bottom - w / 2, right, bottom - w / 2, box.border, w);
}

function placeFlat(slices: Slice[], trailing: number): Placeable {
  const positions: number[] = [];
  const segments: Segment[] = [];
  const open = new Map<Frame, number>();
  let y = 0;

  for (const item of slices) {
    y += item.gap;
    positions.push(y);
    if (item.opens) open.set(item.opens, y);
    y += item.height;

    if (item.closes) {
      segments.push({
        frame: item.closes,
        top: open.get(item.closes) ?? 0,
        bottom: y,
        openTop: false,
        openBottom: false,
      });
    }
  }

  return {
    height: y + trailing,
    draw(pen, x, top) {
      const shifted = segments.map((segment) => ({
        ...segment,
        top: segment.top + top,
        bottom: segment.bottom + top,
      }));

      for (const segment of shifted) paintFill(pen, segment, x);
      slices.forEach((item, index) => item.draw(pen, x, top + (positions[index] ?? 0)));
      for (const segment of shifted) paintBorder(pen, segment, x);
    },
  };
}

/** Blocks stacked in `width`, as one unit that never breaks. */
export function stack(pen: Pen, blocks: Block[], width: number): Placeable {
  const { slices, trailing } = flatten(pen, blocks, 0, width);

  return placeFlat(slices, trailing);
}

function boxPlaceable(pen: Pen, box: BoxBlock, width: number): Placeable {
  const slices = boxSlices(pen, box, 0, width);
  const natural = slices.reduce((sum, item) => sum + item.gap + item.height, 0);
  const close = slices[slices.length - 1];

  if (close && box.minHeight !== undefined && box.minHeight > natural) {
    close.height += box.minHeight - natural;
  }

  return placeFlat(slices, 0);
}

function columnWidthsOf(block: ColumnsBlock, width: number): number[] {
  const total = block.columns.reduce((sum, column) => sum + column.weight, 0);
  const free = width - block.gap * (block.columns.length - 1);

  return block.columns.map((column) => (free * column.weight) / total);
}

/**
 * Columns as bands: horizontal strips cut only where no column has a slice straddling the cut
 * and none asked to keep with what follows. Each band is one slice, so the page can break between
 * any two of them.
 */
function columnsSlices(pen: Pen, block: ColumnsBlock, x: number, width: number): Slice[] {
  const holdsBox = block.columns.some((column) => column.children.some((child) => child.kind === 'box'));

  if (block.stretch || holdsBox) return [atomic(columnsPlaceable(pen, block, width), x)];

  const widths = columnWidthsOf(block, width);
  let left = x;

  const columns = block.columns.map((column, i) => {
    const { slices, trailing } = flatten(pen, column.children, left, widths[i] ?? 0);
    const tops: number[] = [];
    let y = 0;

    left += (widths[i] ?? 0) + block.gap;

    for (const item of slices) {
      y += item.gap;
      tops.push(y);
      y += item.height;
    }

    return { slices, tops, end: y, height: y + trailing };
  });

  const cuttable = (column: (typeof columns)[number], y: number) =>
    y >= column.end ||
    column.slices.some((item, k) => {
      const top = column.tops[k] ?? 0;
      const next = column.tops[k + 1];

      return next !== undefined && !item.keepWithNext && top + item.height <= y && y <= next;
    });

  const cuts = [...new Set(columns.flatMap((column) => column.tops.slice(1)))]
    .sort((a, b) => a - b)
    .filter((y) => columns.every((column) => cuttable(column, y)));
  const edges = [0, ...cuts, Math.max(0, ...columns.map((column) => column.height))];

  return edges.slice(0, -1).map((from, i) => {
    const to = edges[i + 1] ?? from;

    return slice(to - from, (target, dx, y) => {
      for (const column of columns) {
        column.slices.forEach((item, k) => {
          const top = column.tops[k] ?? 0;

          if (top >= from && top < to) item.draw(target, dx, y + top - from);
        });
      }
    });
  });
}

function columnsPlaceable(pen: Pen, block: ColumnsBlock, width: number): Placeable {
  const widths = columnWidthsOf(block, width);

  let placed = block.columns.map((column, i) => stack(pen, column.children, widths[i] ?? 0));
  const height = Math.max(0, ...placed.map((column) => column.height));

  if (block.stretch) {
    placed = block.columns.map((column, i) => {
      const only = column.children.length === 1 ? column.children[0] : undefined;
      const current = placed[i] ?? stack(pen, [], 0);

      if (only?.kind !== 'box' || current.height >= height) return current;

      const margins = (only.marginTop ?? 0) + (only.marginBottom ?? 0);

      return stack(pen, [{ ...only, keepTogether: true, minHeight: height - margins }], widths[i] ?? 0);
    });
  }

  return {
    height,
    draw(target, x, y) {
      let cursor = x;

      placed.forEach((column, i) => {
        column.draw(target, cursor, y);
        cursor += (widths[i] ?? 0) + block.gap;
      });
    },
  };
}

// --- Pages ----------------------------------------------------------------------------------

export interface Flow {
  page: { width: number; height: number; margin: number };
  /** The running header for a section (one report). Every section's must be the same height. */
  header(section: number): Placeable;
  footer: Placeable;
  /** Space above the inline header of a report that starts partway down a page. */
  sectionGap: number;
  /** One block list per report; the second continues on the same page as the first ends. */
  sections: Block[][];
}

export interface LaidPage {
  /** Whose running header this page carries — the report at its top. */
  section: number;
  items: { slice: Slice; y: number }[];
  segments: Segment[];
}

export function paginate(pen: Pen, flow: Flow): LaidPage[] {
  const { page: sheet } = flow;
  const width = sheet.width - 2 * sheet.margin;
  const top = sheet.margin + flow.header(0).height;
  const bottom = sheet.height - sheet.margin - flow.footer.height;
  const capacity = bottom - top;

  const slices: Slice[] = [];

  flow.sections.forEach((blocks, section) => {
    if (section > 0) {
      const inline = flow.header(section);

      slices.push({
        ...slice(inline.height, (target, dx, y) => inline.draw(target, dx, y)),
        gap: flow.sectionGap,
        keepWithNext: true,
        section,
        sectionStart: true,
      });
    }

    for (const item of flatten(pen, blocks, 0, width).slices) {
      item.section = section;
      slices.push(item);
    }
  });

  const pages: LaidPage[] = [];
  const open = new Map<Frame, { top: number; openTop: boolean }>();
  let page: LaidPage = { section: 0, items: [], segments: [] };
  let y = top;
  let fresh = true;

  pages.push(page);

  const turnPage = (section: number) => {
    for (const [frame, segment] of open) {
      page.segments.push({ frame, top: segment.top, bottom: y, openTop: segment.openTop, openBottom: true });
    }

    page = { section, items: [], segments: [] };
    pages.push(page);
    y = top;
    fresh = true;

    for (const segment of open.values()) {
      segment.top = top;
      segment.openTop = true;
    }
  };

  const place = (item: Slice, gap: number) => {
    const at = y + gap;

    page.items.push({ slice: item, y: at });
    if (item.opens) open.set(item.opens, { top: at, openTop: false });
    y = at + item.height;

    if (item.closes) {
      const segment = open.get(item.closes);

      page.segments.push({
        frame: item.closes,
        top: segment?.top ?? at,
        bottom: y,
        openTop: segment?.openTop ?? false,
        openBottom: false,
      });
      open.delete(item.closes);
    }

    fresh = false;
  };

  slices.forEach((item, i) => {
    // Everything chained to this slice by keep-with-next, which must share its page.
    let chain = item.height;

    for (let j = i; slices[j]?.keepWithNext && j + 1 < slices.length; j += 1) {
      const next = slices[j + 1];

      if (next) chain += next.gap + next.height;
    }

    const gap = fresh ? 0 : item.gap;
    const chainFits = y + gap + chain <= bottom;
    const itemFits = y + gap + item.height <= bottom;

    // Break only when what must travel together does not fit here but would on a fresh page, or
    // when this slice alone does not fit. A chain longer than a page is placed piece by piece.
    if (!fresh && ((!chainFits && chain <= capacity) || !itemFits)) turnPage(item.section);

    if (fresh && item.sectionStart) {
      // A report that opens a page needs no inline header: the running header is its own.
      page.section = item.section;
      return;
    }

    if (fresh) {
      page.section = item.section;

      if (item.repeat) {
        for (const row of item.repeat) place(row, 0);
      }
    }

    place(item, fresh ? 0 : item.gap);
  });

  // Nothing can be left open at the end of the document, but a malformed flow must not lose ink.
  for (const [frame, segment] of open) {
    page.segments.push({ frame, top: segment.top, bottom: y, openTop: segment.openTop, openBottom: false });
  }

  return pages;
}

/** Lays the flow out and draws it. Returns the page count. */
export function render(pen: Pen, flow: Flow): number {
  const pages = paginate(pen, flow);
  const x = flow.page.margin;

  pages.forEach((page, index) => {
    if (index > 0) pen.addPage();

    flow.header(page.section).draw(pen, x, flow.page.margin);
    for (const segment of page.segments) paintFill(pen, segment, x);
    for (const item of page.items) item.slice.draw(pen, x, item.y);
    for (const segment of page.segments) paintBorder(pen, segment, x);
    flow.footer.draw(pen, x, flow.page.height - flow.page.margin - flow.footer.height);
  });

  return pages.length;
}
