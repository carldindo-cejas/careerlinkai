/**
 * Just enough CSV for the program → career mapping spreadsheet (2026-09-22): what Excel, Google
 * Sheets and LibreOffice write and read — comma-separated, `"`-quoted when a field holds a comma,
 * quote or line break, `""` for a literal quote, CRLF or LF line endings, an optional UTF-8 BOM.
 */

/** Rows to CSV text, header first. A BOM is prepended so Excel opens UTF-8 (ñ, é) correctly. */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const escape = (value: string | number | null) => {
    const text = value === null ? '' : String(value);

    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  return `﻿${[header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n')}\r\n`;
}

/** CSV text to rows of fields. Blank lines are dropped; quoted fields may span lines. */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;

    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((fields) => fields.some((value) => value.trim() !== ''));
}

/** Save text as a file the browser downloads — no server round trip, no bearer token needed. */
export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
