# Botley — self-hosted BI agent for Slack

Ask business questions about your databases, Salesforce and spreadsheets by @mentioning Botley in Slack or from the web dashboard. Vocabulary: [GLOSSARY.md](GLOSSARY.md). Decisions: [docs/adr/](docs/adr/).

## Run it (Docker)

```sh
cp .env.example .env           # fill in the Slack values, see below
docker compose up --build      # web, worker, mongo
```

- `web` (Next.js) listens on `http://localhost:${WEB_PORT:-3000}`.
- `worker` logs `worker ready` once it has connected to Mongo.
- `mongo` keeps its data in the `mongo-data` volume. Uploads go to the shared `uploads` volume at `/data/uploads` (ADR 0003).

### HTTPS (required for Slack sign-in)

Slack only redirects to **https** URLs. The URL doesn't have to be public: the browser follows the redirect, and the server only makes outbound calls to Slack. Pick one option:

1. **Bundled Caddy with an internal certificate:** set `SITE_ADDRESS` (e.g. `botley.internal` or `localhost`) and `AUTH_URL=https://<SITE_ADDRESS>`, then run `docker compose --profile https up --build`. Caddy's own CA signs the certificate. Trust its root on the machines that use Botley: `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt`.
2. **Your existing reverse proxy or a tunnel** (cloudflared, ngrok, Tailscale Funnel) in front of `web:3000`. Set `AUTH_URL` to its https URL.

### Slack app setup (sign-in)

1. Create a Slack app in your workspace. Under **OAuth & Permissions**, add the redirect URL `$AUTH_URL/api/auth/callback/slack`. Under **User Token Scopes**, add `openid`, `email` and `profile`.
2. Copy the Client ID and Client Secret into `AUTH_SLACK_ID` and `AUTH_SLACK_SECRET`.
3. Set `SLACK_TEAM_ID` to your workspace ID (`T…`). Sign-in from any other workspace is refused.
4. Under **Basic Information > Display Information**, upload `public/botley-avatar.png` as the app icon so the bot has Botley's face.
5. Put the first admins' Slack user IDs (`U…`) in `ADMIN_SLACK_USER_IDS`. They become admins on their **first** sign-in, and everyone else becomes a member. Later changes to the list don't change existing users.

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `AUTH_SECRET` | web | Session encryption secret (`npx auth secret`). |
| `AUTH_SLACK_ID`, `AUTH_SLACK_SECRET` | web | Slack app credentials. |
| `AUTH_URL` | web | The https URL people open. Compose sets `AUTH_TRUST_HOST=true`. |
| `SLACK_TEAM_ID` | web, worker | The only workspace allowed to sign in. Required. |
| `ADMIN_SLACK_USER_IDS` | web, worker | Comma-separated initial admins. |
| `ENCRYPTION_KEY` | web, worker | 32-byte key, base64 or hex (`openssl rand -base64 32`). Encrypts Data Source credentials (AES-256-GCM). Required; keep it stable, or saved credentials become unreadable. |
| `MONGO_URL` | web, worker | Required outside compose. Compose always uses `mongodb://mongo:27017`. |
| `MONGO_DB` | web, worker | Database name. Default `botley`. |
| `UPLOADS_DIR` | web, worker | Where uploaded Datasets are stored as Parquet files. Default `/data/uploads` (the shared compose volume). |
| `WEB_PORT` | compose | Host port for plain-http `web`. Default 3000. |
| `SITE_ADDRESS` | compose (caddy) | Hostname for the `https` profile. |

Process config is parsed and validated in `src/server/config.ts`. Add new variables there and to `.env.example`.

## Develop

Node 24 and Docker (tests start real MongoDB and PostgreSQL servers with Testcontainers).

```sh
npm install
docker run -d --name botley-mongo -p 27017:27017 mongo:8   # or any Mongo
MONGO_URL=mongodb://localhost:27017 npm run dev            # web on :3000 (reads .env)
MONGO_URL=mongodb://localhost:27017 npm run dev:worker     # worker (tsx watch, reads .env)

npm test            # vitest; starts mongo:8 + postgres:17 via testcontainers (or set MONGO_TEST_URL / POSTGRES_TEST_URL)
npm run lint        # eslint
npm run typecheck   # next typegen + tsc
npm run build       # next build (standalone) + dist/worker.mjs (esbuild)
```

## Layout

One package. `web` and `worker` are built from the same TypeScript sources, and `@/` maps to `src/`.

```
src/
  core/            App Core: transport-agnostic use cases. The main test seam.
    index.ts       createAppCore(deps), prepareDatabase(db), public types and errors
    ports.ts       Clock, SlackGateway, LanguageModelProvider
    errors.ts      AppError subclasses (WrongWorkspaceError, ForbiddenError, NotFoundError, LastAdminError, ValidationError)
    secret-box.ts  AES-256-GCM sealing of secrets under ENCRYPTION_KEY
    users/         Slack sign-in, roles (list, setRole), requireAdmin
    preferences/   Per-user UI preferences (theme)
    data-sources/  driver.ts (the driver contract types), data-sources.ts (admin CRUD, test, introspect, Exposed Datasets, withDriver)
    uploads/       uploads.ts (preview/confirm/Replace/Append/delete of uploaded Datasets), storage.ts (the UploadStorage port)
    testing/       Test harness: real Mongo, FakeClock, InMemorySlackGateway, MockLlm
  adapters/        Production implementations of ports (system clock, ...)
  drivers/         Data Source drivers. index.ts = builtInDrivers registry
    contract/      describeDriverContract(): the shared suite every driver runs
    sql/           read-only-guard.ts: single SELECT/WITH check shared by SQL drivers
    postgres/      postgres.ts (driver + kind), testing.ts (per-test databases), postgres.test.ts
    mongodb/       mongodb.ts (driver + kind), testing.ts (per-test databases), mongodb.test.ts
    salesforce/    salesforce.ts (SOQL driver + OAuth kind), testing.ts (fake Salesforce HTTP server)
    uploads/       uploads.ts (DuckDB driver + managed kind), storage.ts (CSV/XLSX -> Parquet UploadStorage), testing.ts
  server/          Process wiring shared by web and worker: env config, bootstrap()
  worker/          Worker process: main.ts (entry), worker.ts (startWorker)
  web/             Web-only code: auth helpers, server runtime, components
    botley/        Botley's state machine (machine.ts) and store (BotleyProvider.tsx)
    theme/         Light/dark theme: toggle, server action, per-user preference
  app/             Next.js App Router routes
    (app)/         Signed-in pages inside the app shell
    signin/        Public sign-in page
  auth.ts          Auth.js config (Slack OIDC only)
  proxy.ts         Per-request access control (Next 16 "proxy", formerly middleware)
test/global-setup.ts   Starts MongoDB and PostgreSQL once per test run
```

### Conventions

- **Business rules live in `src/core`**, not in routes or Slack handlers. `web` and `worker` call `AppCore` use cases and translate `AppError`s into responses.
- **Access control:** `src/web/auth/route-access.ts` decides which paths are public, signed-in or admin, and `src/proxy.ts` enforces it on every request. Admin pages go under `/admin` and admin API routes under `/api/admin`. Admin-only use cases must also check permissions inside the App Core (`users.requireAdmin`) so `worker` callers are covered too.
- **Testing:** test through `createTestHarness()` from `@/core/testing`:

  ```ts
  const h = await createTestHarness({ config: { slackTeamId: 'T1', adminSlackUserIds: ['U1'] } });
  await h.core.users.signIn({ slackUserId: 'U1', slackTeamId: 'T1', name: 'Ada', email: null, image: null });
  h.clock.advance(60_000);                        // FakeClock
  h.llm.script({ toolCalls: [{ toolName: 'listDatasets', input: {} }] }, { text: 'Done' });
  h.slack.messages; h.slack.reactions;            // InMemorySlackGateway records
  await h.close();                                // drops the per-harness database
  ```

  Each harness gets its own database, so test files run in parallel. All `*.test.ts` files under `src/` and `test/` run in `npm test`.
- **Theme:** neubrutalist tokens are CSS variables in `src/app/globals.css`, with shared `.card`, `.btn`, `.tag`, `.actions` and `.page-narrow` classes. Components use the tokens, never raw colours. Text on an accent fill (yellow, pink, cyan, lime, danger) uses `--color-on-accent`, which stays dark in both themes. Check every new page in dark mode.
- **Dark mode:** the root layout sets `<html data-theme="light|dark">` from the user's saved preference (`core.preferences`, Mongo collection `userPreferences`). Without it (`system`, or signed out) the `prefers-color-scheme` media query decides. Dark token values live in two identical blocks in `globals.css`; change both. The header toggle (`src/web/theme/ThemeToggle.tsx`) applies the change at once and saves it with a server action.

### Botley

`<Botley />` (`src/web/components/Botley.tsx`) is an animated SVG with six states: `idle`, `thinking`, `success`, `error`, `empty`, `sleeping`. Animations are CSS in `Botley.module.css`, and all of them stop under `prefers-reduced-motion` (each face still reads without motion). Botley's mood comes from one store per page, `BotleyProvider`, which is mounted in the root layout. Its rules live in `src/web/botley/machine.ts` and are unit tested:

- **Rest** is the page's resting mood. It is `idle` unless the page declares something else: `<Botley rest="empty" />` on an empty page, `<Botley rest="error" />` on an error page. Pages without a `rest` prop go back to `idle`. From a server component that renders Botley somewhere else, use `<BotleyRest state="empty" />`.
- **Cues** are temporary moods caused by events, and they win over rest. `success` flashes for 2.5 s and `error` for 4 s, then Botley returns to rest. `thinking` (and every other state) lasts until settled. Pass `{ forMs }` to choose a duration (`null` means until settled).
- **Sleeping** happens on its own: an idle Botley with no pointer, keyboard, scroll or focus activity for 2 minutes falls asleep, and any activity wakes it.
- `<Botley state="..." />` pins a mood that events can't change. Avoid it on real pages.

How a feature drives Botley from a client component:

```tsx
const { setBotleyState, settleBotley } = useBotley();   // from '@/web/botley/BotleyProvider'

setBotleyState('thinking');               // e.g. Prompt sent, waiting for the agent (chat status 'submitted')
settleBotley();                           // first Answer token arrived / stream finished
setBotleyState('success');                // e.g. Data Source test passed, Report saved (flashes, then back to rest)
setBotleyState('error');                  // e.g. a failed tool call or request (flashes, then back to rest)
```

- From a server component, fire a one-off cue with `<BotleyCue state="success" />` (the home page uses it right after sign-in).
- A form whose submit is slow can use `<PendingButton>` (`src/web/components/PendingButton.tsx`). It shows `thinking` while the form's server action runs. Sign-in and sign-out use it.
- Empty lists (no Conversations, no Data Sources yet) render `<Botley rest="empty" />` next to the empty-state text.

Events wired so far: idle by default, `thinking` while sign-in or sign-out is pending, `success` right after sign-in, `error` on the sign-in error, the forbidden page and the `error.tsx` boundaries, and `empty` on the 404 page. Chat (thinking/answering), Data Source tests and Reports should hook in as described above when they are built.

The Slack avatar `public/botley-avatar.png` (1024 px) is rendered from `public/botley.svg`. After changing the SVG, re-render it with any SVG rasteriser, e.g. `@resvg/resvg-js`: `new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } }).render().asPng()`.

## Data Source drivers

Every Data Source kind implements `DataSourceDriver` (`src/core/data-sources/driver.ts`):

- `dialect`: the query language and flavour, plus short guidance for the model.
- `testConnection()`: never throws; returns `{ ok: true }` or `{ ok: false, error }` with a readable message.
- `introspect()`: Datasets (`id`, `name`, `schema`, `kind`) with columns. Each column has a normalised `type` (`string | integer | number | boolean | date | datetime | json | other`) and the engine's `nativeType`. `id` is unique within the source and is how a query refers to the Dataset (e.g. `public.orders`, `sales."Big Deals"`).
- `execute(query, limits?)`: `{ columns, rows (arrays), truncated, durationMs }`. Default limits are `DEFAULT_QUERY_LIMITS` (30 s, 10 000 rows). It throws `QueryRejectedError` (not a single read-only query), `QueryTimeoutError`, or `QueryFailedError` (the engine's message, which goes back to the model so it can fix the query). Numbers are JS numbers only when exact. Integers too large for JS stay strings, and dates without a zone stay as the engine's text.
- `close()`.

Read-only enforcement lives in the driver, so no caller can bypass it. For SQL, `assertReadOnlySql(sql, flavour)` (`src/drivers/sql/read-only-guard.ts`) accepts one `SELECT`/`WITH` statement with no write, DDL, locking or file keyword outside strings, quoted names and comments. It understands each flavour's quoting (`postgresql`, `mysql`, `tsql`, `duckdb`). The driver then adds engine-level protection. Postgres runs the query as a cursor in `BEGIN TRANSACTION READ ONLY` (always rolled back) over the extended protocol, with `SET LOCAL statement_timeout`, and fetches only `maxRows + 1` rows.

**MongoDB** (`src/drivers/mongodb/mongodb.ts`) takes a structured query instead of a string: `{ find: '<collection>', filter?, projection?, sort?, skip?, limit? }` or `{ aggregate: '<collection>', pipeline: [...] }`. Nothing else is accepted (no other command, no extra option), and `$out`, `$merge`, `$function`, `$where`, `$accumulator` and `$changeStream` are refused wherever they appear, including nested `$lookup`/`$facet` pipelines, `$expr` and projections. Values may be written as Extended JSON (`{ "$date": "…" }`, `{ "$oid": "…" }`). `maxTimeMS` enforces the timeout, and only `maxRows + 1` documents are fetched. Documents are flattened into columns and rows:

- each document is a row, and each field path is a column, in the order the paths first appear across the documents (`_id` first);
- non-empty subdocuments are flattened into dotted paths (`address.city`); arrays and empty subdocuments stay as JSON values (`json`);
- a field a document lacks is `null`;
- `ObjectId` and UUIDs become hex strings, `Decimal128`/`Long` follow the exact-number rule, dates stay `Date`s;
- a column's type is the one type its values share. Integers mixed with doubles are `number`, and any other mix is `other`.

Introspection applies the same rule to a `$sample` of 100 documents per collection (sorted by `_id`). `nativeType` lists the BSON types seen (e.g. `double|int`), and a column is nullable when a sampled document lacks it or holds null. Views are listed with `kind: 'view'`, and `system.*` collections are skipped.

A `DriverKind` registers a driver with the App Core. It has `kind`, `label`, `fields` (form descriptors; `secret: true` fields are encrypted and only ever returned as "set" flags), zod `configSchema`/`secretsSchema`, and `create(config, secrets)`. The admin form renders from `fields`, so a simple kind needs no UI code. App Core code gets a driver with `core.dataSources.withDriver(id, fn)`, which decrypts the credentials and closes the driver afterwards.

### Adding a kind (MySQL, SQL Server, MongoDB, Salesforce, Uploads)

1. Write `src/drivers/<kind>/<kind>.ts` that exports the driver factory and a `DriverKind`. SQL kinds call `assertReadOnlySql(query, '<flavour>')` first, then add whatever the engine offers (MySQL: `START TRANSACTION READ ONLY` + `MAX_EXECUTION_TIME`; SQL Server has no read-only transaction, so roll back and rely on the guard plus a `db_datareader` login). Non-SQL kinds validate their structured query and refuse `$out`, `$merge`, `$function`, `$where` and `$accumulator` with `QueryRejectedError`.
2. Add the test server to `test/global-setup.ts` (`project.provide('<kind>Uri', …)`, with a `<KIND>_TEST_URL` override) and write a `testing.ts` helper that creates an isolated database for each caller. Salesforce uses a fake HTTP server instead.
3. In `src/drivers/<kind>/<kind>.test.ts`, seed the contract fixture (Dataset `orders`: `id` integer, `region` string, `amount` non-integer number; rows `(1,'north',10.5) (2,'south',20) (3,'north',7.25)`) and invoke the suite:

   ```ts
   describeDriverContract({
     kind: 'mysql',
     queries: { ordersById, twentyFiveRows, slow /* ≥ 5 s */, forbidden: { INSERT: '…', 'multiple statements': '…' } },
     async setup() {
       return { driver, unreachableDriver /* wrong password */, countOrders, teardown };
     },
   });
   ```

   `queries` are written in the kind's own language (Mongo passes structured objects). A kind whose Datasets always carry an extra column (Mongo's `_id`) passes `implicitColumns: ['_id']`: introspection must still list it, but it is left out of the fixture comparison. Add tests for anything kind-specific (views, type mapping, quoting) in the same file.
4. Register the kind in `builtInDrivers` (`src/drivers/index.ts`). The admin UI ("Add <label>") and the App Core pick it up from there.

A kind with `managed: true` is created by the App Core instead of the admin form: it is hidden from "Add", and `dataSources.create/update/delete` refuse it. Admins can still refresh its schema and choose its Exposed Datasets.

### Uploads

Uploads is a managed kind (ADR 0003). There is exactly one Uploads Data Source, id `uploads` (`UPLOADS_DATA_SOURCE_ID`), created at startup by `core.uploads.ensureDataSource()` with `config.directory = UPLOADS_DIR`.

- **Flow:** `core.uploads.preview(user, { name, bytes })` checks the 50 MB limit, parses the CSV/XLSX (first row = header; one sheet per XLSX worksheet), stages every sheet and infers column types (`string | integer | number | boolean | date | datetime`). `core.uploads.confirm(user, previewId, choices)` takes per sheet `create` (with a name and corrected types), `replace` or `append` into an existing Dataset. All choices are checked before anything is written. Any signed-in user can upload, Replace and Append; only admins can `delete`. New Datasets are exposed automatically, and earlier exposure choices are kept.
- **Storage:** `UploadStorage` (`src/core/uploads/storage.ts`) is a port. The production adapter, `createUploadStorage` in `src/drivers/uploads/storage.ts`, writes `<UPLOADS_DIR>/<datasetId>.parquet` through DuckDB. It writes to a `.tmp-*` file and renames it into place, so Replace and Append are atomic. Staged sheets live in `.staging/<previewId>/` until they are confirmed, or until they expire after 24 h.
- **Dataset ids** are SQL identifiers made from the name (`Q1 Sales` becomes `q1_sales`). The Dataset metadata (name, source file, sheet, columns, row count, who uploaded it) is in the `uploadedDatasets` collection.
- **Querying:** each `execute` opens a fresh in-memory DuckDB with one view per Parquet file, locks it to the uploads directory (`allowed_directories`, `enable_external_access = false`, `lock_configuration = true`) after the `duckdb` read-only guard has run, and interrupts the query at the timeout.
- **Web:** `/uploads` (the page and `UploadWizard`), with `POST /api/uploads/preview` (multipart) and `POST /api/uploads/confirm` (JSON). `next.config.ts` raises `proxyClientMaxBodySize` to 52 MB and keeps `@duckdb/node-api` external.

### OAuth kinds and token refresh

A kind connected through a consent screen sets `DriverKind.oauth` (`authorizationUrl`, `exchangeCode`, `isConnected`). The App Core owns the flow: `dataSources.startOAuth(actor, id, { redirectUri })` stores a single-use state with the PKCE verifier (Mongo `oauthStates`, 10-minute expiry, bound to the admin who started it) and returns the provider URL. The callback route `GET /api/admin/data-sources/oauth/callback` calls `dataSources.completeOAuth`, which exchanges the code and seals the tokens with the other secrets. Tokens are secrets that aren't form fields, so they're never shown, and they're dropped when an edit changes the config (another org or app means reconnecting). The callback URL is built from `AUTH_URL`.

`DriverKind.create(config, secrets, context)` gets a `context.saveSecrets(update)` when the driver belongs to a saved Data Source. Drivers call it to persist refreshed tokens.

### Salesforce

`src/drivers/salesforce/salesforce.ts`: SOQL over REST (API `v68.0` by default) as the integration user, using plain `fetch`.

- **Setup:** in Salesforce, create an **External Client App** (Connected Apps can't be created any more). Enable OAuth, require PKCE, use the scopes `api refresh_token`, set the callback to `$AUTH_URL/api/admin/data-sources/oauth/callback`, and set the refresh token policy to "valid until revoked". In Botley, add a Salesforce Data Source with the login URL (`https://login.salesforce.com`, `https://test.salesforce.com` or a My Domain URL) and the consumer key and secret. Then click **Connect to Salesforce** on its page and sign in as a read-only integration user.
- **Read-only:** the driver only sends GETs (query, sobjects, describe). `assertReadOnlySoql` accepts one `SELECT` with no `;` and refuses `FOR UPDATE`, `FOR VIEW`, `FOR REFERENCE` and `UPDATE TRACKING|VIEWSTAT`, because those lock records or write stats.
- **Limits:** pages are fetched through `nextRecordsUrl` until `maxRows + 1` records have arrived. One abort signal covers every page and any refresh, so the timeout applies to the whole query.
- **Tokens:** on a 401 the driver refreshes once (shared between concurrent calls), retries, and persists the new access token (and a rotated refresh token) through `saveSecrets`. `invalid_grant` becomes "Reconnect the Data Source".
- **Results:** `attributes` are stripped. Parent relationships become dot-path columns (`Owner.Name`) and child subqueries become JSON arrays. Column types are inferred from the values, because SOQL results carry no column metadata. An empty result takes its column names from the SELECT list, and `SELECT COUNT() FROM X` returns one `count` row.
- **Introspection:** queryable objects, minus `*History`, `*Share`, `*Feed` and `*ChangeEvent`, each described with up to 6 parallel GETs. Each object is a Dataset with `kind: 'object'`, `schema: null` and `id` set to the API name.
- **Tests:** `src/drivers/salesforce/testing.ts` starts a fake org over real HTTP (OAuth token endpoint with PKCE checks, query paging, describe, 401s and revoked refresh tokens). The whole driver contract runs against it. Its SQL-specific parts carry over as follows: "forbidden" uses DML text, `;` chaining and the side-effect clauses above, and `countOrders` reads the fake's fixed records, since the fake answers only GET. A kind-specific test checks that refused queries never reach the server. The OAuth flow is tested through the App Core in `src/core/data-sources/oauth.test.ts`.
