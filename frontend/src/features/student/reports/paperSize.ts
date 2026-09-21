/**
 * The paper the results exports are laid out for.
 *
 * Schools here print on three sizes, and a report typeset for one of them runs off the edge or
 * leaves a band of white on the others. So the size is a choice — on the print sheet (where it
 * becomes the `@page` rule the browser's print dialog starts from) and in the downloaded PDF
 * (where it is the page box jsPDF is given). Both read it from here, so the file and the paper
 * copy always agree.
 *
 * "Short" and "Long" are what the local bond paper is called: Letter and Folio. `css` is spelled
 * out in explicit dimensions rather than a CSS keyword because there is no keyword for Folio, and
 * for the other two a keyword would only be a second way of saying the same thing.
 *
 * The margin is the mockups' 0.62in, whatever the size.
 */

export type PaperSize = 'a4' | 'short' | 'long';

export interface PaperSpec {
  id: PaperSize;
  /** The name on the control. */
  label: string;
  /** The dimensions, as the control spells them out. */
  detail: string;
  /** The `@page size` value. */
  css: string;
  /** The sheet's width as a CSS length — the on-screen column is that wide. */
  cssWidth: string;
  /** PDF points, 72 to the inch. */
  widthPt: number;
  heightPt: number;
}

/** report.css `@page`, and the PDF's own margin. */
export const PAPER_MARGIN_IN = 0.62;

const PAPER: Record<PaperSize, PaperSpec> = {
  a4: {
    id: 'a4',
    label: 'A4',
    detail: '210 × 297 mm',
    css: '210mm 297mm',
    cssWidth: '210mm',
    widthPt: 595.28,
    heightPt: 841.89,
  },
  short: {
    id: 'short',
    label: 'Short (Letter)',
    detail: '8.5 × 11 in',
    css: '8.5in 11in',
    cssWidth: '8.5in',
    widthPt: 612,
    heightPt: 792,
  },
  long: {
    id: 'long',
    label: 'Long (Folio)',
    detail: '8.5 × 13 in',
    css: '8.5in 13in',
    cssWidth: '8.5in',
    widthPt: 612,
    heightPt: 936,
  },
};

export const DEFAULT_PAPER: PaperSize = 'a4';

/** In the order the controls list them. */
export const PAPER_SIZES: readonly PaperSpec[] = [PAPER.a4, PAPER.short, PAPER.long];

export function paperSpec(size: PaperSize = DEFAULT_PAPER): PaperSpec {
  return PAPER[size];
}

/** Anything else — a stale link, a typed URL — is A4. */
export function paperSizeFrom(value: string | null | undefined): PaperSize {
  return value === 'a4' || value === 'short' || value === 'long' ? value : DEFAULT_PAPER;
}

/** The page box the PDF typesetter works in (`layout.ts` `render`), in points. */
export function paperSheet(size: PaperSize = DEFAULT_PAPER): {
  width: number;
  height: number;
  margin: number;
} {
  const paper = paperSpec(size);

  return { width: paper.widthPt, height: paper.heightPt, margin: PAPER_MARGIN_IN * 72 };
}
