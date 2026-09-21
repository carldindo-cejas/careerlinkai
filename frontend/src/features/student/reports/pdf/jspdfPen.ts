import type { jsPDF } from 'jspdf';

import logoUrl from '@/assets/careerlinkai_logo-256.png';
import barlowBold from '@/features/student/reports/pdf/fonts/Barlow-Bold.ttf?url';
import barlowMedium from '@/features/student/reports/pdf/fonts/Barlow-Medium.ttf?url';
import barlowRegular from '@/features/student/reports/pdf/fonts/Barlow-Regular.ttf?url';
import condensedRegular from '@/features/student/reports/pdf/fonts/BarlowCondensed-Regular.ttf?url';
import condensedSemiBold from '@/features/student/reports/pdf/fonts/BarlowCondensed-SemiBold.ttf?url';
import plexMonoBold from '@/features/student/reports/pdf/fonts/IBMPlexMono-Bold.ttf?url';
import plexMonoRegular from '@/features/student/reports/pdf/fonts/IBMPlexMono-Regular.ttf?url';
import type { Face, Pen } from '@/features/student/reports/pdf/layout';

/**
 * The real `Pen`: jsPDF, with the report's own typefaces embedded.
 *
 * **Why the fonts are files in the bundle.** The app loads Barlow from Google Fonts as WOFF2, which
 * jsPDF cannot embed, and the CSP's `connect-src 'self'` would refuse the fetch anyway. So the PDF
 * carries its own TrueType copies (SIL OFL — licences alongside), cut down with fontTools to the
 * Latin, Latin Extended, punctuation, currency, arrow and maths ranges and stripped of hinting,
 * which PDF viewers do not use: about 40 KB each rather than 110. They are fetched only when a
 * student downloads, and jsPDF subsets them again into each file, so a report PDF is tens of KB.
 *
 * IBM Plex Mono stands in for the sheet's `ui-monospace` — the browser's monospace differs per
 * device, and the PDF has to pick one.
 */

interface FaceFile {
  url: string;
  /** hhea ascender / descender over unitsPerEm, read off the files. */
  ascent: number;
  descent: number;
  /** Where a glyph this face lacks is set instead (Barlow has no "→"). */
  fallback: Face;
}

const BARLOW = { ascent: 1, descent: 0.2 };
const PLEX = { ascent: 1.025, descent: 0.275 };

const FACES: Record<Face, FaceFile> = {
  regular: { url: barlowRegular, ...BARLOW, fallback: 'mono' },
  medium: { url: barlowMedium, ...BARLOW, fallback: 'mono' },
  bold: { url: barlowBold, ...BARLOW, fallback: 'monoBold' },
  condensed: { url: condensedRegular, ...BARLOW, fallback: 'mono' },
  condensedBold: { url: condensedSemiBold, ...BARLOW, fallback: 'monoBold' },
  mono: { url: plexMonoRegular, ...PLEX, fallback: 'mono' },
  monoBold: { url: plexMonoBold, ...PLEX, fallback: 'monoBold' },
};

const FACE_NAMES = Object.keys(FACES) as Face[];

export interface PdfAssets {
  /** Each face's TrueType file as a binary string — the form jsPDF's virtual file system takes. */
  fonts: Record<Face, string>;
  logo: Uint8Array;
}

let cached: Promise<PdfAssets> | null = null;

/** Fetched once per page load; a failure is not cached, so "try again" really tries again. */
export function loadPdfAssets(): Promise<PdfAssets> {
  cached ??= fetchAssets().catch((error: unknown) => {
    cached = null;
    throw error;
  });

  return cached;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);

  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status}).`);

  return new Uint8Array(await response.arrayBuffer());
}

function binaryString(bytes: Uint8Array): string {
  let out = '';

  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return out;
}

async function fetchAssets(): Promise<PdfAssets> {
  const [logo, ...fonts] = await Promise.all([
    fetchBytes(logoUrl),
    ...FACE_NAMES.map((face) => fetchBytes(FACES[face].url)),
  ]);

  return {
    logo: logo ?? new Uint8Array(),
    fonts: Object.fromEntries(
      FACE_NAMES.map((face, i) => [face, binaryString(fonts[i] ?? new Uint8Array())]),
    ) as Record<Face, string>,
  };
}

/** The part of jsPDF's font record this reads — its type declares `metadata` as untyped. */
interface EmbeddedFont {
  metadata?: { cmap?: { unicode?: { codeMap?: Record<string, number> } } };
}

/** `format` is the page box in points — every page after the first is added at that size too. */
export function createPen(doc: jsPDF, assets: PdfAssets, format: [number, number]): Pen {
  const coverage = new Map<Face, Set<number>>();

  for (const face of FACE_NAMES) {
    const file = `${face}.ttf`;

    doc.addFileToVFS(file, assets.fonts[face]);
    doc.addFont(file, face, 'normal', 400, 'Identity-H');
    doc.setFont(face, 'normal');

    const codeMap = (doc.getFont() as unknown as EmbeddedFont).metadata?.cmap?.unicode?.codeMap;

    coverage.set(face, new Set(Object.keys(codeMap ?? {}).map(Number)));
  }

  const has = (face: Face, codePoint: number) => coverage.get(face)?.has(codePoint) ?? false;

  /** `text` cut into runs of one face each, a missing glyph falling back to IBM Plex Mono. */
  const runsOf = (text: string, face: Face) => {
    const runs: { text: string; face: Face; length: number }[] = [];

    for (const char of text) {
      const codePoint = char.codePointAt(0) ?? 0;
      const { fallback } = FACES[face];
      const use = has(face, codePoint) || !has(fallback, codePoint) ? face : fallback;
      const last = runs[runs.length - 1];

      if (last && last.face === use) {
        last.text += char;
        last.length += 1;
      } else {
        runs.push({ text: char, face: use, length: 1 });
      }
    }

    return runs;
  };

  const measure = (text: string, face: Face, size: number) => {
    doc.setFont(face, 'normal');
    doc.setFontSize(size);

    return doc.getTextWidth(text);
  };

  return {
    metrics: (face) => ({ ascent: FACES[face].ascent, descent: FACES[face].descent }),

    width(text, style) {
      const tracking = (style.tracking ?? 0) * style.size;
      let width = 0;
      let characters = 0;

      for (const run of runsOf(text, style.face)) {
        width += measure(run.text, run.face, style.size);
        characters += run.length;
      }

      return width + tracking * Math.max(0, characters - 1);
    },

    text(text, x, baseline, style) {
      const tracking = (style.tracking ?? 0) * style.size;
      let cursor = x;

      doc.setTextColor(...style.color);

      for (const run of runsOf(text, style.face)) {
        const width = measure(run.text, run.face, style.size);

        doc.text(run.text, cursor, baseline, {
          baseline: 'alphabetic',
          ...(tracking !== 0 ? { charSpace: tracking } : {}),
        });
        cursor += width + tracking * run.length;
      }
    },

    rect(x, y, width, height, paint) {
      if (paint.fill) doc.setFillColor(...paint.fill);

      if (paint.stroke) {
        doc.setDrawColor(...paint.stroke);
        doc.setLineWidth(paint.lineWidth ?? 0.75);
      }

      doc.rect(x, y, width, height, paint.fill && paint.stroke ? 'FD' : paint.fill ? 'F' : 'S');
    },

    line(x1, y1, x2, y2, color, width) {
      doc.setDrawColor(...color);
      doc.setLineWidth(width);
      doc.line(x1, y1, x2, y2);
    },

    logo(x, y, width, height) {
      // The alias embeds the image once, however many pages draw it.
      doc.addImage(assets.logo, 'PNG', x, y, width, height, 'careerlinkai-logo');
    },

    addPage() {
      doc.addPage(format, 'portrait');
    },
  };
}
