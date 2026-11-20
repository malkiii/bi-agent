/**
 * Files generated from a Table Result Block: CSV and XLSX downloads in the web chat, and the
 * attachments Slack gets for tables too long to show inline. Pure (no I/O).
 */
import type { TableBlock } from '../conversations/answer';
import type { ColumnType } from '../data-sources/driver';

export type TableFileFormat = 'csv' | 'xlsx';

export const TABLE_FILE_TYPES: Record<TableFileFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** RFC 4180 CSV (CRLF, quoted where needed) with a UTF-8 BOM so Excel reads unicode. */
export function tableToCsv(table: TableBlock): string {
  const lines = [table.columns.map((c) => csvField(c.name)), ...table.rows.map((row) => table.columns.map((c, i) => csvCell(row[i], c.type)))];
  return `﻿${lines.map((fields) => fields.join(',')).join('\r\n')}\r\n`;
}

function csvCell(value: unknown, type: ColumnType): string {
  const v = typed(value, type);
  if (v === null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return csvField(neutralise(v));
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Text starting like a formula is prefixed with ' so spreadsheets don't run it. */
function neutralise(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export async function tableToXlsx(table: TableBlock): Promise<Uint8Array> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName(table.title));
  sheet.addRow(table.columns.map((c) => c.name));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of table.rows) sheet.addRow(table.columns.map((c, i) => xlsxCell(row[i], c.type)));
  table.columns.forEach((c, i) => {
    const column = sheet.getColumn(i + 1);
    if (c.type === 'date') column.numFmt = 'yyyy-mm-dd';
    if (c.type === 'datetime') column.numFmt = 'yyyy-mm-dd hh:mm:ss';
    column.width = Math.min(50, Math.max(10, c.name.length + 2));
  });
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function xlsxCell(value: unknown, type: ColumnType): string | number | boolean | Date | null {
  const v = typed(value, type);
  return typeof v === 'string' ? neutralise(v) : v;
}

/** A cell value as the column type says: numbers and dates from their string forms, objects as JSON. */
function typed(value: unknown, type: ColumnType): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  if ((type === 'number' || type === 'integer') && text.trim() !== '' && Number.isFinite(Number(text))) return Number(text);
  if ((type === 'date' || type === 'datetime') && !Number.isNaN(Date.parse(text))) return new Date(text);
  return text;
}

/** Excel sheet names: at most 31 chars, none of []:*?/\ . */
function sheetName(title?: string): string {
  const name = (title ?? '').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return name || 'Result';
}

/** A file name from the table's title (or result id), e.g. `orders-by-region.csv`. */
export function tableFileName(table: Pick<TableBlock, 'title' | 'resultId'>, format: TableFileFormat): string {
  const base = table.title ? slug(table.title) : (table.resultId ?? '').replace(/[^\w-]+/g, '_');
  return `${base || 'table'}.${format}`;
}

function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
