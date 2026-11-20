import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ForbiddenError, ValidationError } from '@/core';
import { createTestHarness, type TestHarness } from '@/core/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';
const OTHER = 'UOTHER';

let h: TestHarness;
beforeEach(async () => {
  h = await createTestHarness({ config: { slackTeamId: 'T1', adminSlackUserIds: [ADMIN] } });
  for (const slackUserId of [ADMIN, MEMBER, OTHER]) {
    await h.core.users.signIn({ slackUserId, slackTeamId: 'T1', name: slackUserId, email: null, image: null });
  }
});
afterEach(() => h.close());

const csv = (text: string) => new TextEncoder().encode(text);

const SALES_CSV = csv(
  [
    'Order Date,Region,Units,Amount,Paid',
    '2026-01-05,north,3,10.50,true',
    '2026-01-06,south,1,20,false',
    '2026-01-07,north,2,7.25,true',
  ].join('\n'),
);

async function uploadsDataSource() {
  return (await h.core.dataSources.list()).find((ds) => ds.kind === 'uploads');
}

async function query(sql: string) {
  const ds = await uploadsDataSource();
  return h.core.dataSources.withDriver(ds!.id, (driver) => driver.execute(sql));
}

describe('uploading a CSV file', () => {
  test('the preview shows the columns with inferred types and the first rows', async () => {
    const preview = await h.core.uploads.preview(MEMBER, { filename: 'Sales 2026.csv', content: SALES_CSV });

    expect(preview.sheets).toEqual([
      {
        sheet: 'Sales 2026',
        datasetName: 'sales_2026',
        rowCount: 3,
        columns: [
          { name: 'order_date', header: 'Order Date', type: 'date' },
          { name: 'region', header: 'Region', type: 'string' },
          { name: 'units', header: 'Units', type: 'integer' },
          { name: 'amount', header: 'Amount', type: 'number' },
          { name: 'paid', header: 'Paid', type: 'boolean' },
        ],
        sampleRows: [
          ['2026-01-05', 'north', '3', '10.50', 'true'],
          ['2026-01-06', 'south', '1', '20', 'false'],
          ['2026-01-07', 'north', '2', '7.25', 'true'],
        ],
      },
    ]);
  });

  test('confirming creates an Exposed Dataset in the shared Uploads Data Source, queryable with SQL', async () => {
    const preview = await h.core.uploads.preview(MEMBER, { filename: 'Sales 2026.csv', content: SALES_CSV });

    const [dataset] = await h.core.uploads.confirm(MEMBER, {
      uploadId: preview.uploadId,
      sheets: [{ sheet: 'Sales 2026', datasetName: 'sales_2026', mode: 'new' }],
    });

    expect(dataset).toMatchObject({ datasetId: 'sales_2026', rowCount: 3 });
    const ds = await uploadsDataSource();
    expect(ds).toMatchObject({ name: 'Uploads', kind: 'uploads' });
    expect(ds!.datasets).toEqual([
      expect.objectContaining({
        id: 'sales_2026',
        kind: 'sheet',
        exposed: true,
        columns: [
          expect.objectContaining({ name: 'order_date', type: 'date' }),
          expect.objectContaining({ name: 'region', type: 'string' }),
          expect.objectContaining({ name: 'units', type: 'integer' }),
          expect.objectContaining({ name: 'amount', type: 'number' }),
          expect.objectContaining({ name: 'paid', type: 'boolean' }),
        ],
      }),
    ]);
    const result = await query('SELECT region, sum(amount) AS total, sum(units) AS units FROM sales_2026 GROUP BY region ORDER BY region');
    expect(result.rows).toEqual([
      ['north', 17.75, 5],
      ['south', 20, 1],
    ]);
  });
});

describe('correcting column types', () => {
  test('a corrected type is used instead of the inferred one', async () => {
    const preview = await h.core.uploads.preview(MEMBER, {
      filename: 'stores.csv',
      content: csv('store,zip\nA,2000\nB,3000\n'),
    });
    expect(preview.sheets[0]!.columns.map((c) => c.type)).toEqual(['string', 'integer']);

    await h.core.uploads.confirm(MEMBER, {
      uploadId: preview.uploadId,
      sheets: [{ sheet: 'stores', datasetName: 'stores', mode: 'new', columnTypes: { zip: 'string' } }],
    });

    expect((await query('SELECT zip FROM stores ORDER BY store')).rows).toEqual([['2000'], ['3000']]);
    expect((await uploadsDataSource())!.datasets[0]!.columns[1]).toMatchObject({ name: 'zip', type: 'string' });
  });

  test('a type the values do not fit is refused, naming the column and row', async () => {
    const preview = await h.core.uploads.preview(MEMBER, {
      filename: 'stores.csv',
      content: csv('store,zip\nA,2000\nB,unknown\n'),
    });

    await expect(
      h.core.uploads.confirm(MEMBER, {
        uploadId: preview.uploadId,
        sheets: [{ sheet: 'stores', datasetName: 'stores', mode: 'new', columnTypes: { zip: 'integer' } }],
      }),
    ).rejects.toThrow(/zip \(integer\): row 3 has "unknown"/);
    expect(await uploadsDataSource()).toBeUndefined();
  });
});

async function workbook(sheets: Record<string, unknown[][]>): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) book.addWorksheet(name).addRows(rows);
  return new Uint8Array(await book.xlsx.writeBuffer());
}

describe('uploading an XLSX workbook', () => {
  test('each sheet becomes its own Dataset, with typed cells read as such', async () => {
    const content = await workbook({
      Orders: [
        ['Order Id', 'Placed', 'Total'],
        [1, new Date('2026-01-05T00:00:00Z'), 10.5],
        [2, new Date('2026-01-06T00:00:00Z'), 20],
      ],
      'Sales Reps': [
        ['Name', 'Active'],
        ['Ada', true],
        ['Grace', false],
      ],
    });

    const preview = await h.core.uploads.preview(MEMBER, { filename: 'Q1.xlsx', content });

    expect(preview.sheets.map((s) => [s.sheet, s.datasetName, s.rowCount, s.columns.map((c) => c.type)])).toEqual([
      ['Orders', 'q1_orders', 2, ['integer', 'date', 'number']],
      ['Sales Reps', 'q1_sales_reps', 2, ['string', 'boolean']],
    ]);

    await h.core.uploads.confirm(MEMBER, {
      uploadId: preview.uploadId,
      sheets: preview.sheets.map((s) => ({ sheet: s.sheet, datasetName: s.datasetName, mode: 'new' as const })),
    });

    expect((await uploadsDataSource())!.datasets.map((d) => d.id)).toEqual(['q1_orders', 'q1_sales_reps']);
    expect((await query('SELECT order_id, placed, total FROM q1_orders ORDER BY order_id')).rows).toEqual([
      [1, '2026-01-05', 10.5],
      [2, '2026-01-06', 20],
    ]);
    expect((await query('SELECT name FROM q1_sales_reps WHERE active')).rows).toEqual([['Ada']]);
    expect((await h.core.uploads.list()).map((d) => [d.datasetId, d.sheet, d.rowCount, d.createdBy])).toEqual([
      ['q1_orders', 'Orders', 2, MEMBER],
      ['q1_sales_reps', 'Sales Reps', 2, MEMBER],
    ]);
  });
});

describe('re-uploading to an existing Dataset', () => {
  async function upload(actor: string, text: string, mode: 'new' | 'replace' | 'append', columnTypes?: Record<string, 'string'>) {
    const preview = await h.core.uploads.preview(actor, { filename: 'sales.csv', content: csv(text) });
    return h.core.uploads.confirm(actor, {
      uploadId: preview.uploadId,
      sheets: [{ sheet: 'sales', datasetName: 'sales', mode, ...(columnTypes && { columnTypes }) }],
    });
  }

  test('a new Dataset with a name already in use is refused', async () => {
    await upload(MEMBER, 'region,amount\nnorth,1\n', 'new');

    await expect(upload(OTHER, 'region,amount\nsouth,2\n', 'new')).rejects.toThrow(/already exists.*Replace or Append/);
  });

  test('two members saving a new Dataset under the same name at once: one wins, the other is refused', async () => {
    const [a, b] = await Promise.all(
      ['region,amount\nnorth,1\n', 'region,amount\nsouth,2\n'].map(async (text, i) => {
        const preview = await h.core.uploads.preview([MEMBER, OTHER][i]!, { filename: 'sales.csv', content: csv(text) });
        return preview.uploadId;
      }),
    );

    const results = await Promise.allSettled(
      [a!, b!].map((uploadId, i) =>
        h.core.uploads.confirm([MEMBER, OTHER][i]!, {
          uploadId,
          sheets: [{ sheet: 'sales', datasetName: 'sales', mode: 'new' }],
        }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(ValidationError);
    expect(refused.reason.message).toMatch(/already exists/);
    expect((await query('SELECT count(*) AS n FROM sales')).rows).toEqual([[1]]);
  });

  test('Replace swaps all rows (and may change the columns)', async () => {
    await upload(MEMBER, 'region,amount\nnorth,1\nsouth,2\n', 'new');

    const [replaced] = await upload(OTHER, 'region,amount,units\neast,5,1\n', 'replace');

    expect(replaced).toMatchObject({ rowCount: 1, createdBy: MEMBER, updatedBy: OTHER });
    expect((await query('SELECT * FROM sales')).rows).toEqual([['east', 5, 1]]);
  });

  test('Replace keeps descriptions and Synonyms of the Dataset and of unchanged columns', async () => {
    await upload(MEMBER, 'region,amount\nnorth,1\n', 'new');
    const ds = (await uploadsDataSource())!;
    await h.core.dataSources.updateDatasetDetails(ADMIN, ds.id, 'sales', {
      description: 'Sales by region',
      synonyms: ['revenue table'],
      columns: { region: { synonyms: ['area'] }, amount: { synonyms: ['revenue'] } },
    });

    await upload(OTHER, 'region,amount\neast,a lot\n', 'replace');

    const [dataset] = (await uploadsDataSource())!.datasets;
    expect(dataset).toMatchObject({ description: 'Sales by region', synonyms: ['revenue table'], exposed: true });
    expect(dataset!.columns[0]).toMatchObject({ name: 'region', synonyms: ['area'] });
    expect(dataset!.columns[1]).toEqual(expect.not.objectContaining({ synonyms: expect.anything() }));
  });

  test('Append adds rows to the existing ones', async () => {
    await upload(MEMBER, 'region,amount\nnorth,1\nsouth,2\n', 'new');

    const [appended] = await upload(OTHER, 'region,amount\neast,3\n', 'append');

    expect(appended).toMatchObject({ rowCount: 3 });
    expect((await query('SELECT region, amount FROM sales ORDER BY amount')).rows).toEqual([
      ['north', 1],
      ['south', 2],
      ['east', 3],
    ]);
  });

  test('Append is refused when the columns do not match, leaving the Dataset unchanged', async () => {
    await upload(MEMBER, 'region,amount\nnorth,1\n', 'new');

    await expect(upload(OTHER, 'region,total\neast,3\n', 'append')).rejects.toThrow(/same columns/);
    await expect(upload(OTHER, 'region,amount\neast,3\n', 'append', { amount: 'string' })).rejects.toThrow(
      /same columns/,
    );
    expect((await query('SELECT * FROM sales')).rows).toEqual([['north', 1]]);
  });

  test('Replace and Append need an existing Dataset', async () => {
    await expect(upload(MEMBER, 'region,amount\nnorth,1\n', 'append')).rejects.toThrow(/no uploaded Dataset named sales/);
  });
});

describe('limits', () => {
  test('files over 50 MB are refused with a clear message', async () => {
    const content = new Uint8Array(50 * 1024 * 1024 + 1);

    await expect(h.core.uploads.preview(MEMBER, { filename: 'huge.csv', content })).rejects.toThrow(
      'This file is 50.1 MB; uploads can be at most 50 MB.',
    );
  });

  test('only CSV and XLSX files are accepted', async () => {
    await expect(h.core.uploads.preview(MEMBER, { filename: 'notes.txt', content: csv('a') })).rejects.toThrow(
      /\.csv or \.xlsx/,
    );
  });

  test('only the member who previewed an upload can confirm it', async () => {
    const preview = await h.core.uploads.preview(MEMBER, { filename: 'sales.csv', content: csv('a\n1\n') });

    await expect(
      h.core.uploads.confirm(OTHER, {
        uploadId: preview.uploadId,
        sheets: [{ sheet: 'sales', datasetName: 'sales', mode: 'new' }],
      }),
    ).rejects.toThrow(/expired/);
  });
});

describe('asking about an uploaded Dataset', () => {
  const NORTH_SQL = "SELECT region, sum(amount) AS total FROM sales_2026 WHERE region = 'north' GROUP BY region";

  async function uploadSales() {
    const preview = await h.core.uploads.preview(MEMBER, { filename: 'Sales 2026.csv', content: SALES_CSV });
    const [dataset] = await h.core.uploads.confirm(MEMBER, {
      uploadId: preview.uploadId,
      sheets: [{ sheet: 'Sales 2026', datasetName: 'sales_2026', mode: 'new' }],
    });
    return dataset!.dataSourceId;
  }

  function scriptNorthAnswer(dataSourceId: string) {
    h.llm.script(
      { toolCalls: [{ toolName: 'listDatasets', input: {} }] },
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId, query: NORTH_SQL, name: 'north' } }] },
      { toolCalls: [{ toolName: 'emitTable', input: { resultId: 'north' } }] },
      { text: '' },
    );
  }

  test('a teammate gets an Answer from the web chat, naming the Uploads Data Source', async () => {
    const uploadsId = await uploadSales();
    scriptNorthAnswer(uploadsId);

    const conversation = await h.core.conversations.startWeb(OTHER);
    const answer = await h.core.conversations.ask(OTHER, conversation.id, 'How much did north sell?');

    expect(answer.status).toBe('complete');
    expect(answer.blocks).toMatchObject([{ type: 'table', rows: [['north', 17.75]] }]);
    expect(answer.sources).toEqual([{ dataSourceId: uploadsId, name: 'Uploads', datasets: ['sales_2026'] }]);
    const listed = JSON.stringify(h.llm.model.doStreamCalls[1]?.prompt);
    expect(listed).toContain('sales_2026');
    expect(listed).toContain('duckdb');
  });

  test('a teammate gets an Answer in Slack', async () => {
    const uploadsId = await uploadSales();
    scriptNorthAnswer(uploadsId);

    await h.core.slackBot.handlePrompt({ userId: OTHER, channel: 'CSALES', ts: '100.1', text: '<@UBOT> north?', botUserId: 'UBOT' });

    const [reply] = h.slack.thread('CSALES', '100.1');
    expect(JSON.stringify(reply!.blocks)).toContain('Sources: Uploads (sales_2026)');
    expect(JSON.stringify(reply!.blocks)).toContain('17.75');
  });
});

describe('managing uploaded Datasets', () => {
  test('an admin deletes an uploaded Dataset; members cannot', async () => {
    const preview = await h.core.uploads.preview(MEMBER, { filename: 'Sales 2026.csv', content: SALES_CSV });
    await h.core.uploads.confirm(MEMBER, {
      uploadId: preview.uploadId,
      sheets: [{ sheet: 'Sales 2026', datasetName: 'sales_2026', mode: 'new' }],
    });

    await expect(h.core.uploads.delete(MEMBER, 'sales_2026')).rejects.toThrow(ForbiddenError);
    await h.core.uploads.delete(ADMIN, 'sales_2026');

    expect((await uploadsDataSource())!.datasets).toEqual([]);
    expect(await h.core.uploads.list()).toEqual([]);
    await expect(query('SELECT * FROM sales_2026')).rejects.toThrow(/sales_2026/);
  });

  test('the Uploads Data Source cannot be added, edited or deleted on the admin form', async () => {
    const preview = await h.core.uploads.preview(MEMBER, { filename: 'a.csv', content: csv('x\n1\n') });
    await h.core.uploads.confirm(MEMBER, { uploadId: preview.uploadId, sheets: [{ sheet: 'a', datasetName: 'a', mode: 'new' }] });
    const ds = (await uploadsDataSource())!;
    const input = { name: 'Mine', kind: 'uploads', config: {}, secrets: {} };

    await expect(h.core.dataSources.create(ADMIN, input)).rejects.toThrow(ValidationError);
    await expect(h.core.dataSources.update(ADMIN, ds.id, input)).rejects.toThrow(ValidationError);
    await expect(h.core.dataSources.delete(ADMIN, ds.id)).rejects.toThrow(ValidationError);
  });
});
