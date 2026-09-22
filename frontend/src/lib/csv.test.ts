import { describe, expect, it } from 'vitest';

import { parseCsv, toCsv } from '@/lib/csv';

describe('csv', () => {
  it('round-trips commas, quotes and line breaks', () => {
    const rows = [['BSCS', 'Computer Science, Data', 'He said "hi"', 'two\nlines', null]];
    const text = toCsv(['a', 'b', 'c', 'd', 'e'], rows);

    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c', 'd', 'e'],
      ['BSCS', 'Computer Science, Data', 'He said "hi"', 'two\nlines', ''],
    ]);
  });

  it('reads CRLF files with a BOM, as Excel writes them, and skips blank lines', () => {
    expect(parseCsv('﻿x,y\r\n1,2\r\n\r\n3,4\r\n')).toEqual([
      ['x', 'y'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });
});
