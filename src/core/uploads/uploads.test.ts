import { readdir } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ForbiddenError, NotFoundError, UPLOADS_DATA_SOURCE_ID, ValidationError } from '@/core';
import { createTestHarness, type TestHarness } from '@/core/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';

let h: TestHarness;
beforeEach(async () => {
  h = await createTestHarness({ config: { slackTeamId: 'T1', adminSlackUserIds: [ADMIN] } });
  for (const slackUserId of [ADMIN, MEMBER]) {
    await h.core.users.signIn({ slackUserId, slackTeamId: 'T1', name: slackUserId, email: null, image: null });
  }
});
afterEach(() => h.close());

const csv = (text: string, name = 'orders.csv') => ({ name, bytes: new TextEncoder().encode(text) });

const ORDERS_CSV = csv(
  ['id,region,amount,shipped_on,zip', '1,north,10.5,2026-01-05,00123', '2,south,20,2026-01-06,04567', '3,north,7.25,,00999'].join(
    '\n',
  ),
);

async function query(sql: string) {
  return h.core.dataSources.withDriver(UPLOADS_DATA_SOURCE_ID, (driver) => driver.execute(sql));
}

async function workbook(sheets: Record<string, unknown[][]>) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) wb.addWorksheet(name).addRows(rows);
  return { name: 'book.xlsx', bytes: new Uint8Array(await wb.xlsx.writeBuffer()) };
}

describe('uploading a CSV', () => {
  test('the preview shows each column with its inferred type and the first rows', async () => {
    const preview = await h.core.uploads.preview(MEMBER, ORDERS_CSV);

    expect(preview.fileName).toBe('orders.csv');
    expect(preview.sheets).toEqual([
      {
        index: 0,
        name: 'orders',
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'region', type: 'string' },
          { name: 'amount', type: 'number' },
          { name: 'shipped_on', type: 'date' },
          { name: 'zip', type: 'integer' },
        ],
        rowCount: 3,
        sampleRows: [
          ['1', 'north', '10.5', '2026-01-05', '00123'],
          ['2', 'south', '20', '2026-01-06', '04567'],
          ['3', 'north', '7.25', null, '00999'],
        ],
      },
    ]);
  });

  test('confirming with a corrected type creates a Dataset in the shared Uploads Data Source that the agent can query', async () => {
    const preview = await h.core.uploads.preview(MEMBER, ORDERS_CSV);

    const [dataset] = await h.core.uploads.confirm(MEMBER, preview.id, [
      { sheet: 0, mode: 'create', name: 'Orders 2026', types: ['integer', 'string', 'number', 'date', 'string'] },
    ]);

    expect(dataset).toMatchObject({
      id: 'orders_2026',
      name: 'Orders 2026',
      fileName: 'orders.csv',
      rowCount: 3,
      createdBy: MEMBER,
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'region', type: 'string' },
        { name: 'amount', type: 'number' },
        { name: 'shipped_on', type: 'date' },
        { name: 'zip', type: 'string' },
      ],
    });
    expect(await h.core.uploads.list()).toEqual([dataset]);

    const source = await h.core.dataSources.get(UPLOADS_DATA_SOURCE_ID);
    expect(source).toMatchObject({ name: 'Uploads', kind: 'uploads' });
    expect(source.datasets).toMatchObject([{ id: 'orders_2026', kind: 'sheet', exposed: true }]);

    const result = await query('SELECT region, sum(amount) AS total, min(zip) AS zip FROM orders_2026 GROUP BY 1 ORDER BY 1');
    expect(result.rows).toEqual([
      ['north', 17.75, '00123'],
      ['south', 20, '04567'],
    ]);
  });

  test('a correction the values do not fit is refused, naming the column and value', async () => {
    const preview = await h.core.uploads.preview(MEMBER, ORDERS_CSV);

    const confirming = h.core.uploads.confirm(MEMBER, preview.id, [
      { sheet: 0, mode: 'create', name: 'orders', types: ['integer', 'integer', 'number', 'date', 'string'] },
    ]);

    await expect(confirming).rejects.toThrow(ValidationError);
    await expect(confirming).rejects.toThrow(/region.*north|north.*region/);
    expect(await h.core.uploads.list()).toEqual([]);
  });

  test('a Dataset name already in use is refused; Replace or Append are the ways to update it', async () => {
    const first = await h.core.uploads.preview(MEMBER, ORDERS_CSV);
    await h.core.uploads.confirm(MEMBER, first.id, [{ sheet: 0, mode: 'create', name: 'orders' }]);

    const second = await h.core.uploads.preview(MEMBER, ORDERS_CSV);
    await expect(
      h.core.uploads.confirm(MEMBER, second.id, [{ sheet: 0, mode: 'create', name: 'Orders' }]),
    ).rejects.toThrow(/already exists/);
  });

  test('headers become unique column names, and blank headers get a name', async () => {
    const preview = await h.core.uploads.preview(MEMBER, csv('Name,,Name\na,b,c\n'));

    expect(preview.sheets[0]!.columns.map((c) => c.name)).toEqual(['Name', 'column_2', 'Name_2']);
  });
});

describe('uploading an XLSX workbook', () => {
  test('each sheet becomes its own Dataset, with Excel numbers, dates and booleans typed', async () => {
    const file = await workbook({
      Deals: [
        ['Deal', 'Amount', 'Closed', 'Won'],
        ['Acme', 1200.5, new Date(Date.UTC(2026, 0, 5)), true],
        ['Globex', 300, new Date(Date.UTC(2026, 1, 1)), false],
      ],
      Reps: [
        ['Rep', 'Quota'],
        ['Ada', 5000],
      ],
    });

    const preview = await h.core.uploads.preview(MEMBER, file);
    expect(preview.sheets.map((s) => ({ name: s.name, columns: s.columns, rowCount: s.rowCount }))).toEqual([
      {
        name: 'Deals',
        rowCount: 2,
        columns: [
          { name: 'Deal', type: 'string' },
          { name: 'Amount', type: 'number' },
          { name: 'Closed', type: 'date' },
          { name: 'Won', type: 'boolean' },
        ],
      },
      { name: 'Reps', rowCount: 1, columns: [{ name: 'Rep', type: 'string' }, { name: 'Quota', type: 'integer' }] },
    ]);

    const created = await h.core.uploads.confirm(MEMBER, preview.id, [
      { sheet: 0, mode: 'create', name: 'Deals' },
      { sheet: 1, mode: 'create', name: 'Reps' },
    ]);

    expect(created.map((d) => d.id)).toEqual(['deals', 'reps']);
    expect(created.map((d) => d.sheetName)).toEqual(['Deals', 'Reps']);
    expect((await query('SELECT "Deal", "Amount", "Closed", "Won" FROM deals ORDER BY 1')).rows).toEqual([
      ['Acme', 1200.5, '2026-01-05', true],
      ['Globex', 300, '2026-02-01', false],
    ]);
    expect((await query('SELECT * FROM reps')).rows).toEqual([['Ada', 5000]]);
  });

  test('sheets left out of the confirmation are not saved', async () => {
    const preview = await h.core.uploads.preview(MEMBER, await workbook({ A: [['x'], [1]], B: [['y'], [2]] }));

    await h.core.uploads.confirm(MEMBER, preview.id, [{ sheet: 1, mode: 'create', name: 'only b' }]);

    expect((await h.core.uploads.list()).map((d) => d.id)).toEqual(['only_b']);
  });
});

describe('updating an uploaded Dataset', () => {
  async function createOrders() {
    const preview = await h.core.uploads.preview(MEMBER, ORDERS_CSV);
    const [dataset] = await h.core.uploads.confirm(MEMBER, preview.id, [{ sheet: 0, mode: 'create', name: 'orders' }]);
    return dataset!;
  }

  test('Replace swaps in the new rows; the Dataset file is the only file left behind', async () => {
    const orders = await createOrders();
    h.clock.advance(60_000);

    const preview = await h.core.uploads.preview(ADMIN, csv('id,region,amount,shipped_on,zip\n9,east,1,2026-03-01,1\n'));
    const [replaced] = await h.core.uploads.confirm(ADMIN, preview.id, [
      { sheet: 0, mode: 'replace', datasetId: orders.id },
    ]);

    expect(replaced).toMatchObject({ id: 'orders', rowCount: 1, createdBy: MEMBER, updatedBy: ADMIN });
    expect(replaced!.updatedAt.getTime()).toBe(orders.updatedAt.getTime() + 60_000);
    expect((await query('SELECT id, region FROM orders')).rows).toEqual([[9, 'east']]);
    expect((await readdir(h.uploadsDir)).filter((f) => !f.startsWith('.'))).toEqual(['orders.parquet']);
  });

  test('Append adds the rows, converting them to the Dataset column types', async () => {
    const orders = await createOrders();

    const preview = await h.core.uploads.preview(MEMBER, csv('id,region,amount,shipped_on,zip\n4,east,5,2026-03-01,00042\n'));
    const [appended] = await h.core.uploads.confirm(MEMBER, preview.id, [
      { sheet: 0, mode: 'append', datasetId: orders.id },
    ]);

    expect(appended).toMatchObject({ rowCount: 4 });
    expect((await query('SELECT id, region, amount, zip FROM orders ORDER BY id')).rows).toEqual([
      [1, 'north', 10.5, 123],
      [2, 'south', 20, 4567],
      [3, 'north', 7.25, 999],
      [4, 'east', 5, 42],
    ]);
  });

  test('Append is refused when the columns do not match, leaving the Dataset unchanged', async () => {
    const orders = await createOrders();

    const preview = await h.core.uploads.preview(MEMBER, csv('id,region,total\n4,east,5\n'));
    const appending = h.core.uploads.confirm(MEMBER, preview.id, [{ sheet: 0, mode: 'append', datasetId: orders.id }]);

    await expect(appending).rejects.toThrow(ValidationError);
    await expect(appending).rejects.toThrow(/columns/i);
    expect((await query('SELECT count(*) FROM orders')).rows).toEqual([[3]]);
  });

  test('Replace or Append into a Dataset that does not exist is refused', async () => {
    const preview = await h.core.uploads.preview(MEMBER, ORDERS_CSV);

    await expect(
      h.core.uploads.confirm(MEMBER, preview.id, [{ sheet: 0, mode: 'replace', datasetId: 'nope' }]),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('limits and validation', () => {
  test('files over 50 MB are refused with a clear message', async () => {
    const big = { name: 'big.csv', bytes: new Uint8Array(50 * 1024 * 1024 + 1) };

    await expect(h.core.uploads.preview(MEMBER, big)).rejects.toThrow(ValidationError);
    await expect(h.core.uploads.preview(MEMBER, big)).rejects.toThrow('Files can be at most 50 MB; this one is 50.0 MB.');
  });

  test('only CSV and XLSX files are accepted', async () => {
    await expect(h.core.uploads.preview(MEMBER, csv('x', 'notes.txt'))).rejects.toThrow(/CSV or XLSX/);
  });

  test('a file that is not really a workbook is refused readably', async () => {
    await expect(h.core.uploads.preview(MEMBER, csv('not a zip', 'fake.xlsx'))).rejects.toThrow(ValidationError);
  });

  test('a file with only a header row has nothing to upload', async () => {
    await expect(h.core.uploads.preview(MEMBER, csv('a,b\n'))).rejects.toThrow(/no rows/i);
  });

  test('people who never signed in cannot upload', async () => {
    await expect(h.core.uploads.preview('USTRANGER', ORDERS_CSV)).rejects.toThrow(ForbiddenError);
  });

  test('an unknown or already used preview cannot be confirmed', async () => {
    const preview = await h.core.uploads.preview(MEMBER, ORDERS_CSV);
    await h.core.uploads.confirm(MEMBER, preview.id, [{ sheet: 0, mode: 'create', name: 'orders' }]);

    await expect(
      h.core.uploads.confirm(MEMBER, preview.id, [{ sheet: 0, mode: 'create', name: 'again' }]),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('managing the Uploads Data Source', () => {
  test('it exists from the start, and admins cannot edit or delete it', async () => {
    const source = await h.core.uploads.ensureDataSource();

    expect(source).toMatchObject({ id: UPLOADS_DATA_SOURCE_ID, name: 'Uploads', kind: 'uploads', datasets: [] });
    await expect(h.core.dataSources.delete(ADMIN, UPLOADS_DATA_SOURCE_ID)).rejects.toThrow(ValidationError);
    await expect(
      h.core.dataSources.update(ADMIN, UPLOADS_DATA_SOURCE_ID, { name: 'X', kind: 'uploads', config: {}, secrets: {} }),
    ).rejects.toThrow(ValidationError);
    await expect(
      h.core.dataSources.create(ADMIN, { name: 'More uploads', kind: 'uploads', config: { directory: '/' }, secrets: {} }),
    ).rejects.toThrow(ValidationError);
    expect(await h.core.dataSources.testConnection(ADMIN, { ...source, secrets: {}, id: source.id })).toEqual({
      ok: true,
    });
  });

  test('admins choose which uploaded Datasets are exposed, and new uploads keep earlier choices', async () => {
    const first = await h.core.uploads.preview(MEMBER, ORDERS_CSV);
    await h.core.uploads.confirm(MEMBER, first.id, [{ sheet: 0, mode: 'create', name: 'orders' }]);
    await h.core.dataSources.setExposedDatasets(ADMIN, UPLOADS_DATA_SOURCE_ID, []);

    const second = await h.core.uploads.preview(MEMBER, ORDERS_CSV);
    await h.core.uploads.confirm(MEMBER, second.id, [{ sheet: 0, mode: 'create', name: 'more orders' }]);

    const { datasets } = await h.core.dataSources.get(UPLOADS_DATA_SOURCE_ID);
    expect(datasets.map(({ id, exposed }) => ({ id, exposed }))).toEqual([
      { id: 'more_orders', exposed: true },
      { id: 'orders', exposed: false },
    ]);
  });

  test('admins delete uploaded Datasets; members cannot', async () => {
    const preview = await h.core.uploads.preview(MEMBER, ORDERS_CSV);
    await h.core.uploads.confirm(MEMBER, preview.id, [{ sheet: 0, mode: 'create', name: 'orders' }]);

    await expect(h.core.uploads.delete(MEMBER, 'orders')).rejects.toThrow(ForbiddenError);
    await h.core.uploads.delete(ADMIN, 'orders');

    expect(await h.core.uploads.list()).toEqual([]);
    expect((await h.core.dataSources.get(UPLOADS_DATA_SOURCE_ID)).datasets).toEqual([]);
    await expect(query('SELECT * FROM orders')).rejects.toThrow(/orders/);
  });
});
