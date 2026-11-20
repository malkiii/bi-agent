/**
 * Reads an uploaded CSV or XLSX file into sheets of cells. The first row of each sheet is
 * its header row. A CSV is one sheet named after the file.
 */
import { ValidationError } from '../errors';

/** A cell as read from the file: CSV cells are always text, XLSX cells keep their type. */
export type Cell = string | number | boolean | Date | null;

export interface RawSheet {
  name: string;
  header: string[];
  rows: Cell[][];
}

export type UploadFormat = 'csv' | 'xlsx';

export function uploadFormat(filename: string): UploadFormat {
  const extension = filename.toLowerCase().split('.').pop();
  if (extension === 'csv' || extension === 'xlsx') return extension;
  throw new ValidationError('Upload a .csv or .xlsx file.', { file: 'Only CSV and XLSX files are supported' });
}

/** The file name without folders or extension. */
export function baseName(filename: string): string {
  const name = filename.split(/[\\/]/).pop() ?? filename;
  return name.replace(/\.[^.]*$/, '') || 'upload';
}

export async function readUploadFile(filename: string, content: Uint8Array): Promise<RawSheet[]> {
  const sheets = uploadFormat(filename) === 'csv' ? [readCsv(baseName(filename), content)] : await readXlsx(content);
  const usable = sheets.filter((s) => s.header.some((h) => h.trim() !== ''));
  if (usable.length === 0) {
    throw new ValidationError('The file is empty: the first row must hold the column names.', { file: 'Empty file' });
  }
  return usable;
}

function readCsv(name: string, content: Uint8Array): RawSheet {
  let text = new TextDecoder('utf-8').decode(content);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = parseCsv(text, sniffDelimiter(text));
  const [header = [], ...rows] = records;
  return { name, header, rows };
}

/** Comma, semicolon or tab: whichever appears most in the header line (outside quotes). */
function sniffDelimiter(text: string): string {
  const counts = new Map<string, number>([[',', 0], [';', 0], ['\t', 0]]);
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && counts.has(c)) counts.set(c, counts.get(c)! + 1);
  }
  return [...counts.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

/** RFC 4180: quoted fields may hold delimiters, newlines and doubled quotes. Blank lines are skipped. */
function parseCsv(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRecord = () => {
    record.push(field);
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
    field = '';
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else field += c;
      i++;
    } else if (c === '"' && field === '') {
      quoted = true;
      i++;
    } else if (c === delimiter) {
      record.push(field);
      field = '';
      i++;
    } else if (c === '\r' || c === '\n') {
      endRecord();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (quoted) throw new ValidationError('The CSV file has an unterminated quoted field.', { file: 'Malformed CSV' });
  if (field !== '' || record.length > 0) endRecord();
  return records;
}

async function readXlsx(content: Uint8Array): Promise<RawSheet[]> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(content as unknown as ArrayBuffer);
  } catch {
    throw new ValidationError('This file could not be read as an XLSX workbook.', { file: 'Malformed XLSX' });
  }
  return workbook.worksheets.map((sheet) => {
    const rows: Cell[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows[rowNumber - 1] = values.map(xlsxCell);
    });
    const [header = [], ...body] = Array.from(rows, (r) => r ?? []);
    return {
      name: sheet.name,
      header: header.map((cell) => (cell === null ? '' : cellText(cell))),
      rows: body.filter((r) => r.some((cell) => cell !== null && cell !== '')),
    };
  });
}

/** ExcelJS cell values: formulas keep their result, rich text and hyperlinks their text. */
function xlsxCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) {
    return value;
  }
  if (typeof value === 'object') {
    const v = value as { result?: unknown; richText?: { text: string }[]; text?: unknown; error?: unknown };
    if ('result' in v) return xlsxCell(v.result);
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return xlsxCell(v.text);
  }
  return null;
}

/** How a cell reads as text, e.g. in the preview. Dates at midnight UTC read as plain dates. */
export function cellText(cell: Cell): string {
  if (cell === null) return '';
  if (cell instanceof Date) {
    const iso = cell.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
  }
  return String(cell);
}
