import ExcelJS from 'exceljs';
import { describe, expect, test } from 'vitest';
import type { TableBlock } from '../conversations/answer';
import { tableFileName, tableToCsv, tableToXlsx } from './table-files';

const TABLE: TableBlock = {
  type: 'table',
  title: 'Orders by région',
  resultId: 'orders',
  columns: [
    { name: 'region', type: 'string' },
    { name: 'orders', type: 'integer' },
    { name: 'total', type: 'number' },
    { name: 'first_order', type: 'datetime' },
    { name: 'active', type: 'boolean' },
    { name: 'meta', type: 'json' },
  ],
  rows: [
    ['Zürich, "Nord"', 3, 17.75, new Date('2026-01-05T09:30:00Z'), true, { tier: 'gold' }],
    ['東京\nline two', 1, '20.5', '2026-02-01T00:00:00.000Z', false, null],
    [null, null, null, null, null, ['a', 'b']],
  ],
  truncated: false,
};

const EMPTY: TableBlock = { type: 'table', columns: [{ name: 'region', type: 'string' }, { name: 'total', type: 'number' }], rows: [], truncated: false };

const BOM = '﻿';

describe('tableToCsv', () => {
  test('writes a header and every row, quoting commas, quotes and newlines, with a BOM so Excel reads unicode', () => {
    expect(tableToCsv(TABLE)).toBe(
      BOM +
        [
          'region,orders,total,first_order,active,meta',
          '"Zürich, ""Nord""",3,17.75,2026-01-05T09:30:00.000Z,true,"{""tier"":""gold""}"',
          '"東京\nline two",1,20.5,2026-02-01T00:00:00.000Z,false,',
          ',,,,,"[""a"",""b""]"',
        ].join('\r\n') +
        '\r\n',
    );
  });

  test('an empty table is just the header', () => {
    expect(tableToCsv(EMPTY)).toBe(`${BOM}region,total\r\n`);
  });

  test('cells that look like formulas are neutralised', () => {
    const table: TableBlock = { ...EMPTY, rows: [['=HYPERLINK("http://x")', -3], ['+1', 2]] };

    expect(tableToCsv(table)).toBe(`${BOM}region,total\r\n"'=HYPERLINK(""http://x"")",-3\r\n'+1,2\r\n`);
  });
});

async function readXlsx(bytes: Uint8Array) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0]!;
  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    rows.push(Array.from({ length: sheet.columnCount }, (_, i) => row.getCell(i + 1).value));
  });
  return { sheet, rows };
}

describe('tableToXlsx', () => {
  test('one sheet with a bold header row and typed cells: numbers, dates, booleans, unicode text', async () => {
    const { sheet, rows } = await readXlsx(await tableToXlsx(TABLE));

    expect(sheet.name).toBe('Orders by région');
    expect(sheet.getRow(1).font?.bold).toBe(true);
    expect(rows).toEqual([
      ['region', 'orders', 'total', 'first_order', 'active', 'meta'],
      ['Zürich, "Nord"', 3, 17.75, new Date('2026-01-05T09:30:00Z'), true, '{"tier":"gold"}'],
      ['東京\nline two', 1, 20.5, new Date('2026-02-01T00:00:00Z'), false, null],
      [null, null, null, null, null, '["a","b"]'],
    ]);
  });

  test('an empty table is just the header row', async () => {
    const { sheet, rows } = await readXlsx(await tableToXlsx(EMPTY));

    expect(sheet.name).toBe('Result');
    expect(rows).toEqual([['region', 'total']]);
  });
});

describe('tableFileName', () => {
  test('is built from the title, falling back to the result id', () => {
    expect(tableFileName(TABLE, 'csv')).toBe('orders-by-region.csv');
    expect(tableFileName({ ...EMPTY, resultId: 'sales_by_month' }, 'xlsx')).toBe('sales_by_month.xlsx');
    expect(tableFileName(EMPTY, 'xlsx')).toBe('table.xlsx');
  });
});
