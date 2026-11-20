/**
 * Column names and types for uploaded sheets: names become SQL-friendly identifiers, types
 * are inferred from the cells, and cells are converted to the (possibly corrected) type.
 */
import { cellText, type Cell } from './read-file';

export const UPLOAD_COLUMN_TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'datetime'] as const;
export type UploadColumnType = (typeof UPLOAD_COLUMN_TYPES)[number];

/** A value ready to store in a column of its type. Dates and datetimes are `Date`s in UTC. */
export type StoredValue = string | number | boolean | Date | null;

/** Dataset ids and column names: lowercase letters, digits and underscores, so SQL needs no quoting. */
export const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** "Order Date" → "order_date"; empty when nothing usable is left. */
export function toIdentifier(text: string): string {
  const id = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 63)
    .replace(/_+$/, '');
  return /^[0-9]/.test(id) ? `_${id}`.slice(0, 63) : id;
}

/** One identifier per header, unique within the sheet: blanks become `column_<n>`, repeats get `_2`, `_3`… */
export function columnNames(header: readonly string[]): string[] {
  const used = new Set<string>();
  return header.map((text, i) => {
    const base = toIdentifier(text) || `column_${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base.slice(0, 60)}_${n}`;
    used.add(name);
    return name;
  });
}

const INTEGER = /^[-+]?\d+$/;
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?$/;
const TRUE_WORDS = new Set(['true', 'yes']);
const FALSE_WORDS = new Set(['false', 'no']);

const isBlank = (cell: Cell) => cell === null || (typeof cell === 'string' && cell.trim() === '');

const isMidnightUtc = (d: Date) => d.getTime() % 86_400_000 === 0;

function validDate(text: string): Date | undefined {
  const m = DATE.exec(text);
  if (!m) return undefined;
  const d = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text ? undefined : d;
}

function validDatetime(text: string): Date | undefined {
  const m = DATETIME.exec(text);
  if (!m || !validDate(m[1]!)) return undefined;
  const zone = m[5] ? m[5].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : 'Z';
  const d = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** What one non-blank cell could be, most specific first. */
function cellKind(cell: Exclude<Cell, null>): UploadColumnType {
  if (typeof cell === 'boolean') return 'boolean';
  if (typeof cell === 'number') return Number.isSafeInteger(cell) ? 'integer' : 'number';
  if (cell instanceof Date) return isMidnightUtc(cell) ? 'date' : 'datetime';
  const text = cell.trim();
  const lower = text.toLowerCase();
  if (TRUE_WORDS.has(lower) || FALSE_WORDS.has(lower)) return 'boolean';
  // Leading zeros (zip codes, account numbers) are identifiers, not numbers.
  if (INTEGER.test(text) && !/^[-+]?0\d/.test(text) && Number.isSafeInteger(Number(text))) return 'integer';
  if (NUMBER.test(text) && !/^[-+]?0\d/.test(text)) return 'number';
  if (validDate(text)) return 'date';
  if (validDatetime(text)) return 'datetime';
  return 'string';
}

/** The narrowest type every non-blank cell fits; `string` when they disagree or are all blank. */
export function inferColumnType(cells: Iterable<Cell>): UploadColumnType {
  const kinds = new Set<UploadColumnType>();
  for (const cell of cells) {
    if (!isBlank(cell)) kinds.add(cellKind(cell!));
    if (kinds.has('string')) return 'string';
  }
  if (kinds.size === 0) return 'string';
  if (kinds.size === 1) return [...kinds][0]!;
  if ([...kinds].every((k) => k === 'integer' || k === 'number')) return 'number';
  if ([...kinds].every((k) => k === 'date' || k === 'datetime')) return 'datetime';
  return 'string';
}

/** Converts a cell to `type`: null for blanks, undefined when the cell doesn't fit. */
export function convertCell(cell: Cell, type: UploadColumnType): StoredValue | undefined {
  if (isBlank(cell)) return null;
  const value = cell!;
  switch (type) {
    case 'string':
      return typeof value === 'string' ? value : cellText(value);
    case 'integer': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && INTEGER.test(value.trim()) ? Number(value) : NaN;
      return Number.isSafeInteger(n) ? n : undefined;
    }
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && NUMBER.test(value.trim()) ? Number(value) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const text = String(value).trim().toLowerCase();
      if (TRUE_WORDS.has(text) || text === '1') return true;
      if (FALSE_WORDS.has(text) || text === '0') return false;
      return undefined;
    }
    case 'date': {
      if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
      if (typeof value !== 'string') return undefined;
      const text = value.trim();
      const d = validDate(text) ?? validDatetime(text);
      return d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : undefined;
    }
    case 'datetime': {
      if (value instanceof Date) return value;
      if (typeof value !== 'string') return undefined;
      const text = value.trim();
      return validDatetime(text) ?? validDate(text);
    }
  }
}
