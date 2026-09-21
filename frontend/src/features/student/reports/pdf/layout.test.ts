import { describe, expect, it } from 'vitest';

import {
  paginate,
  render,
  type Block,
  type Flow,
  type Pen,
  type Placeable,
  type TableTheme,
  type TextStyle,
} from '@/features/student/reports/pdf/layout';

/**
 * The PDF's pagination, against a pen with fixed-width glyphs so every height is arithmetic.
 *
 * The page below has 240pt of content area (300 tall, 10 margins, 20 header, 20 footer): a line
 * of text is 15pt and a table row 21pt (15 + 2 × 2.5 padding + 1 rule).
 */

const TEXT: TextStyle = { face: 'regular', size: 10, color: [0, 0, 0], lineHeight: 1.5 };

const THEME: TableTheme = {
  cell: TEXT,
  head: TEXT,
  sub: TEXT,
  padX: 2,
  padY: 2.5,
  rule: [0, 0, 0],
  headRule: [0, 0, 0],
  ruleWidth: 1,
  bar: { height: 5, track: [0, 0, 0], fill: [0, 0, 0], border: [0, 0, 0] },
};

const TOP = 30;
const BOTTOM = 270;
const ROW = 21;

interface Drawn {
  page: number;
  text: string;
  baseline: number;
}

function recordingPen(): Pen & { drawn: Drawn[] } {
  let page = 1;
  const drawn: Drawn[] = [];

  return {
    drawn,
    metrics: () => ({ ascent: 0.8, descent: 0.2 }),
    width: (text, style) => text.length * style.size * 0.5,
    text: (text, _x, baseline) => drawn.push({ page, text, baseline }),
    rect: () => {},
    line: () => {},
    logo: () => {},
    addPage: () => {
      page += 1;
    },
  };
}

function label(text: string, height: number): Placeable {
  return { height, draw: (target, x, y) => target.text(text, x, y + height, TEXT) };
}

function flow(sections: Block[][]): Flow {
  return {
    page: { width: 200, height: 300, margin: 10 },
    header: (section) => label(`HEADER-${section}`, 20),
    footer: label('FOOTER', 20),
    sectionGap: 10,
    sections,
  };
}

function line(text: string, extra: Partial<Block> = {}): Block {
  return { kind: 'text', runs: [{ text }], style: TEXT, ...extra } as Block;
}

function lines(count: number, prefix = 'Line'): Block[] {
  return Array.from({ length: count }, (_, i) => line(`${prefix}-${i + 1}`));
}

function rows(count: number): Block {
  return {
    kind: 'table',
    theme: THEME,
    columns: [{}],
    headerRows: 1,
    rows: [
      [{ runs: [{ text: 'HEAD' }], head: true }],
      ...Array.from({ length: count }, (_, i) => [{ runs: [{ text: `Row-${i + 1}` }] }]),
    ],
  };
}

function onPage(pen: { drawn: Drawn[] }, page: number): string[] {
  return pen.drawn.filter((entry) => entry.page === page).map((entry) => entry.text);
}

function pageOf(pen: { drawn: Drawn[] }, text: string): number | undefined {
  return pen.drawn.find((entry) => entry.text === text)?.page;
}

describe('PDF pagination', () => {
  /**
   * The defect this replaces, in the printed sheet: a block that did not fit went to a fresh page
   * and took everything after it along, leaving the page before it mostly blank.
   */
  it('runs a table straight on from the text above it and carries it over the page', () => {
    const pen = recordingPen();

    // Eight lines (120pt) leave 120pt: the header and four 21pt rows fit, the fifth does not.
    const pages = render(pen, flow([[...lines(8), rows(20)]]));

    expect(pages).toBe(3);
    expect(onPage(pen, 1)).toEqual(expect.arrayContaining(['Line-8', 'HEAD', 'Row-4']));
    expect(pageOf(pen, 'Row-5')).toBe(2);

    // The header repeats at the top of the page the table continues on.
    const second = onPage(pen, 2).filter((text) => !text.startsWith('HEADER') && text !== 'FOOTER');
    expect(second.slice(0, 2)).toEqual(['HEAD', 'Row-5']);
  });

  it('never ends a page more than one row short of the bottom inside a table', () => {
    const pen = recordingPen();
    const laid = paginate(pen, flow([[...lines(3), rows(60)]]));

    for (const page of laid.slice(0, -1)) {
      const last = page.items[page.items.length - 1];

      expect(last).toBeDefined();
      expect(BOTTOM - ((last?.y ?? 0) + (last?.slice.height ?? 0))).toBeLessThan(ROW);
    }
  });

  it('takes a heading over with the first thing under it', () => {
    const pen = recordingPen();

    // Fifteen lines reach 255: a 15pt heading still fits, the heading and its first row do not.
    render(
      pen,
      flow([[...lines(15), line('Heading', { keepWithNext: true }), rows(3)]]),
    );

    expect(pageOf(pen, 'Line-15')).toBe(1);
    expect(pageOf(pen, 'Heading')).toBe(2);
    expect(pageOf(pen, 'Row-1')).toBe(2);
  });

  it('never leaves one line of a paragraph alone at the foot or the head of a page', () => {
    const pen = recordingPen();
    const words = Array.from({ length: 5 }, (_, i) => `Para${i + 1}${'x'.repeat(30)}`).join(' ');

    // One 15pt line of room: the paragraph's first line would be an orphan, so all of it moves.
    render(pen, flow([[...lines(15), line(words)]]));

    expect(onPage(pen, 1).some((text) => text.startsWith('Para'))).toBe(false);
    expect(onPage(pen, 2).filter((text) => text.startsWith('Para'))).toHaveLength(5);
  });

  it('splits a long box across pages and draws it open where it breaks', () => {
    const pen = recordingPen();
    const box: Block = {
      kind: 'box',
      border: [0, 0, 0],
      padding: { top: 5, right: 5, bottom: 5, left: 5 },
      children: lines(20, 'Boxed'),
    };

    const laid = paginate(pen, flow([[...lines(4), box]]));

    expect(laid).toHaveLength(2);
    expect(laid[0]?.segments[0]).toMatchObject({ openTop: false, openBottom: true });
    expect(laid[1]?.segments[0]).toMatchObject({ openTop: true, openBottom: false });
    // It started on the first page, right under the text, rather than waiting for a fresh one.
    expect(laid[0]?.segments[0]?.top).toBe(TOP + 4 * 15);
  });

  /** The Likert tally beside the bands table: both break together, a row at a time. */
  it('breaks side-by-side tables where their rows line up, not before the pair', () => {
    const pen = recordingPen();
    const pair: Block = {
      kind: 'columns',
      gap: 4,
      columns: [
        { weight: 1, children: [rows(8)] },
        { weight: 1, children: [rows(8)] },
      ],
    };

    // Twelve lines reach 210: 60pt left, room for the header (21) and Row-1 (21) of each column,
    // ending at 252. Row-2 would end at 273, past the 270 bottom.
    const laid = paginate(pen, flow([[...lines(12), pair]]));

    expect(laid).toHaveLength(2);

    const first = laid[0]?.items ?? [];
    const last = first[first.length - 1];

    expect(BOTTOM - ((last?.y ?? 0) + (last?.slice.height ?? 0))).toBeLessThan(ROW);

    render(pen, flow([[...lines(12), pair]]));
    expect(pen.drawn.filter((entry) => entry.text === 'Row-1').map((entry) => entry.page)).toEqual([1, 1]);
    expect(pen.drawn.filter((entry) => entry.text === 'Row-2').map((entry) => entry.page)).toEqual([2, 2]);
  });

  /**
   * …unless the pair asks to stay whole, which the report's distribution does: cut between rows,
   * its second column arrived on the next page with no heading above it.
   */
  it('moves a keepTogether pair whole rather than breaking between its rows', () => {
    const pen = recordingPen();
    const pair: Block = {
      kind: 'columns',
      gap: 4,
      keepTogether: true,
      columns: [
        { weight: 1, children: [rows(8)] },
        { weight: 1, children: [rows(8)] },
      ],
    };

    render(pen, flow([[...lines(12), pair]]));

    // Nothing of it on the first page; every row of both columns on the second.
    expect(onPage(pen, 1)).toEqual(['HEADER-0', ...lines(12).map((_, i) => `Line-${i + 1}`), 'FOOTER']);
    expect(pen.drawn.filter((entry) => entry.text === 'Row-1').map((entry) => entry.page)).toEqual([2, 2]);
    expect(pen.drawn.filter((entry) => entry.text === 'Row-8').map((entry) => entry.page)).toEqual([2, 2]);
  });

  it('starts the second report on the same page, under its own header', () => {
    const pen = recordingPen();

    render(pen, flow([lines(3, 'First'), lines(3, 'Second')]));

    expect(pageOf(pen, 'Second-1')).toBe(1);

    const inline = pen.drawn.find((entry) => entry.text === 'HEADER-1');
    expect(inline?.page).toBe(1);
    expect(inline?.baseline).toBeGreaterThan(TOP);
  });

  it('gives a report that opens a page its own running header instead of an inline one', () => {
    const pen = recordingPen();

    // Fifteen lines leave 15pt: too little for the 20pt inline header, so the report turns the
    // page — where the running header already names it.
    render(pen, flow([lines(15, 'First'), lines(2, 'Second')]));

    expect(pageOf(pen, 'Second-1')).toBe(2);
    expect(pen.drawn.filter((entry) => entry.text === 'HEADER-1')).toEqual([
      { page: 2, text: 'HEADER-1', baseline: 10 + 20 },
    ]);
  });
});
