/**
 * First line of read-only enforcement for every SQL driver: the query must be exactly one
 * SELECT/WITH statement with no forbidden keyword outside strings, quoted identifiers and
 * comments. Drivers add engine-level protection on top (read-only transactions, timeouts).
 *
 * Deliberately conservative: an unquoted column named like a forbidden keyword (e.g. `update`)
 * is refused, and the message tells the model to quote it.
 */
import { QueryRejectedError } from '@/core/data-sources/driver';

export type SqlFlavour = 'postgresql' | 'mysql' | 'tsql' | 'duckdb';

/**
 * Words that could make a SELECT/WITH statement write, lock, run code or touch files on some
 * engine: data-modifying CTEs, SELECT INTO / INTO OUTFILE, locking clauses, T-SQL statements
 * that need no semicolon separator, file and remote readers.
 */
const FORBIDDEN_WORDS = new Set([
  'insert', 'update', 'delete', 'merge', 'upsert', 'truncate', 'drop', 'alter', 'create', 'grant',
  'revoke', 'into', 'copy', 'call', 'exec', 'execute', 'lock', 'set', 'declare', 'dbcc', 'shutdown',
  'kill', 'backup', 'restore', 'bulk', 'attach', 'detach', 'pragma', 'openrowset', 'opendatasource',
  'openquery', 'outfile', 'dumpfile',
]);

/**
 * Extra words per flavour. T-SQL needs no semicolon between statements, so `SELECT 1 COMMIT`
 * is two statements: refuse the statement keywords that are not already covered above.
 * MySQL: server file reads, advisory locks that outlive the query on a pooled connection, and
 * MariaDB sequence functions (a sequence advance survives the rollback).
 */
const FLAVOUR_FORBIDDEN_WORDS: Record<SqlFlavour, ReadonlySet<string>> = {
  postgresql: new Set(),
  duckdb: new Set(),
  mysql: new Set(['load_file', 'get_lock', 'handler', 'nextval', 'setval']),
  tsql: new Set([
    'waitfor', 'commit', 'rollback', 'begin', 'save', 'use', 'receive', 'reconfigure', 'checkpoint',
    'revert', 'setuser', 'goto', 'raiserror', 'throw', 'writetext', 'updatetext', 'readtext', 'openxml',
  ]),
};

/**
 * Word pairs refused in every flavour, whose words alone are harmless: row locking, and
 * `NEXT VALUE FOR` (SQL Server, MariaDB), which advances a sequence even if the transaction rolls back.
 */
const FORBIDDEN_PAIRS: readonly [string, string][] = [
  ['for', 'share'],
  ['next', 'value'],
];

interface Token {
  kind: 'word' | 'semicolon' | 'other';
  text: string;
  /** Offset just past the token in the original SQL. */
  end: number;
}

/** Returns the statement without trailing semicolons and comments, or throws QueryRejectedError. */
export function assertReadOnlySql(sql: string, flavour: SqlFlavour): string {
  const tokens = tokenize(sql, flavour);

  let last = tokens.length;
  while (last > 0 && tokens[last - 1]!.kind === 'semicolon') last--;
  const body = tokens.slice(0, last);
  if (body.length === 0) throw new QueryRejectedError('The query is empty.');
  if (body.some((t) => t.kind === 'semicolon')) {
    throw new QueryRejectedError('Only one statement is allowed; remove the extra statements.');
  }

  const first = body.find((t) => !(t.kind === 'other' && t.text === '('));
  const firstWord = first?.kind === 'word' ? first.text.toLowerCase() : '';
  if (firstWord !== 'select' && firstWord !== 'with') {
    throw new QueryRejectedError('Only read-only SELECT or WITH queries are allowed.');
  }

  const extra = FLAVOUR_FORBIDDEN_WORDS[flavour];
  const forbidden = body.find((t) => {
    const word = t.text.toLowerCase();
    return t.kind === 'word' && (FORBIDDEN_WORDS.has(word) || extra.has(word));
  });
  if (forbidden) {
    throw new QueryRejectedError(
      `Only read-only queries are allowed, and this one contains ${forbidden.text.toUpperCase()}. ` +
        `If that is a column or table name, quote it.`,
    );
  }

  for (let i = 0; i + 1 < body.length; i++) {
    const [a, b] = [body[i]!, body[i + 1]!];
    if (a.kind !== 'word' || b.kind !== 'word') continue;
    const pair = FORBIDDEN_PAIRS.find(([x, y]) => a.text.toLowerCase() === x && b.text.toLowerCase() === y);
    if (pair) {
      throw new QueryRejectedError(`Only read-only queries are allowed; remove ${pair.join(' ').toUpperCase()}.`);
    }
  }

  return sql.slice(0, body[body.length - 1]!.end).trim();
}

function tokenize(sql: string, flavour: SqlFlavour): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  const dollarQuotes = flavour === 'postgresql' || flavour === 'duckdb';
  const unterminated = (what: string): never => {
    throw new QueryRejectedError(`The query has an unterminated ${what}.`);
  };
  const push = (kind: Token['kind'], start: number, end: number) => {
    tokens.push({ kind, text: sql.slice(start, end), end });
    return end;
  };

  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (/\s/.test(c)) {
      i++;
    } else if (
      // MySQL only starts a `--` comment when whitespace follows; `1--1` is arithmetic.
      (c === '-' && next === '-' && (flavour !== 'mysql' || i + 2 >= n || /\s/.test(sql[i + 2]!))) ||
      (c === '#' && flavour === 'mysql')
    ) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === '/' && next === '*') {
      if (flavour === 'mysql' && /^\/\*M?!/.test(sql.slice(i, i + 4))) {
        throw new QueryRejectedError('Executable comments (/*! ... */) are not allowed; remove them.');
      }
      i = skipBlockComment(sql, i, dollarQuotes) ?? unterminated('comment');
    } else if (c === "'") {
      const backslashes = flavour === 'mysql' || isEscapeStringPrefix(tokens, i);
      i = push('other', i, skipQuoted(sql, i, "'", backslashes) ?? unterminated('string'));
    } else if (c === '"') {
      i = push('other', i, skipQuoted(sql, i, '"', flavour === 'mysql') ?? unterminated('quoted name'));
    } else if (c === '`' && flavour === 'mysql') {
      i = push('other', i, skipQuoted(sql, i, '`', false) ?? unterminated('quoted name'));
    } else if (c === '[' && flavour === 'tsql') {
      i = push('other', i, skipQuoted(sql, i, ']', false) ?? unterminated('quoted name'));
    } else if (c === '$' && dollarQuotes && dollarTag(sql, i)) {
      const tag = dollarTag(sql, i)!;
      const close = sql.indexOf(tag, i + tag.length);
      if (close === -1) unterminated('dollar-quoted string');
      i = push('other', i, close + tag.length);
    } else if (c === ';') {
      i = push('semicolon', i, i + 1);
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-￿]/.test(sql[j]!)) j++;
      i = push('word', i, j);
    } else {
      i = push('other', i, i + 1);
    }
  }
  return tokens;
}

/** Postgres `E'...'` strings use backslash escapes. */
function isEscapeStringPrefix(tokens: Token[], quoteAt: number): boolean {
  const prev = tokens[tokens.length - 1];
  return prev?.kind === 'word' && /^[eE]$/.test(prev.text) && prev.end === quoteAt;
}

/** Returns the index after the closing quote (a doubled quote escapes it), or null. */
function skipQuoted(sql: string, start: number, close: string, backslashEscapes: boolean): number | null {
  let i = start + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (backslashEscapes && c === '\\') {
      i += 2;
    } else if (c === close) {
      if (sql[i + 1] === close) i += 2;
      else return i + 1;
    } else {
      i++;
    }
  }
  return null;
}

function skipBlockComment(sql: string, start: number, nested: boolean): number | null {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      depth = nested ? depth + 1 : 1;
      i += 2;
    } else if (sql[i] === '*' && sql[i + 1] === '/') {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return null;
}

/** `$$` or `$tag$` starting at `i` (but not a `$1` parameter). */
function dollarTag(sql: string, i: number): string | null {
  const match = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
  return match ? match[0] : null;
}
