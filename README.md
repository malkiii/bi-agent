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
4. Put the first admins' Slack user IDs (`U…`) in `ADMIN_SLACK_USER_IDS`. They become admins on their **first** sign-in, and everyone else becomes a member. Later changes to the list don't change existing users.

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
    data-sources/  driver.ts (the driver contract types), data-sources.ts (admin CRUD, test, introspect, Exposed Datasets, withDriver)
    testing/       Test harness: real Mongo, FakeClock, InMemorySlackGateway, MockLlm
  adapters/        Production implementations of ports (system clock, ...)
  drivers/         Data Source drivers. index.ts = builtInDrivers registry
    contract/      describeDriverContract(): the shared suite every driver runs
    sql/           read-only-guard.ts: single SELECT/WITH check shared by SQL drivers
    postgres/      postgres.ts (driver + kind), testing.ts (per-test databases), postgres.test.ts
  server/          Process wiring shared by web and worker: env config, bootstrap()
  worker/          Worker process: main.ts (entry), worker.ts (startWorker)
  web/             Web-only code: auth helpers, server runtime, components
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
- **Theme:** neubrutalist tokens are CSS variables in `src/app/globals.css`, with shared `.card`, `.btn` and `.tag` classes. Components use the tokens, never raw colours. Botley is `src/web/components/Botley.tsx`.

## Data Source drivers

Every Data Source kind implements `DataSourceDriver` (`src/core/data-sources/driver.ts`):

- `dialect`: the query language and flavour, plus short guidance for the model.
- `testConnection()`: never throws; returns `{ ok: true }` or `{ ok: false, error }` with a readable message.
- `introspect()`: Datasets (`id`, `name`, `schema`, `kind`) with columns. Each column has a normalised `type` (`string | integer | number | boolean | date | datetime | json | other`) and the engine's `nativeType`. `id` is unique within the source and is how a query refers to the Dataset (e.g. `public.orders`, `sales."Big Deals"`).
- `execute(query, limits?)`: `{ columns, rows (arrays), truncated, durationMs }`. Default limits are `DEFAULT_QUERY_LIMITS` (30 s, 10 000 rows). It throws `QueryRejectedError` (not a single read-only query), `QueryTimeoutError`, or `QueryFailedError` (the engine's message, which goes back to the model so it can fix the query). Numbers are JS numbers only when exact. Integers too large for JS stay strings, and dates without a zone stay as the engine's text.
- `close()`.

Read-only enforcement lives in the driver, so no caller can bypass it. For SQL, `assertReadOnlySql(sql, flavour)` (`src/drivers/sql/read-only-guard.ts`) accepts one `SELECT`/`WITH` statement with no write, DDL, locking or file keyword outside strings, quoted names and comments. It understands each flavour's quoting (`postgresql`, `mysql`, `tsql`, `duckdb`). The driver then adds engine-level protection. Postgres runs the query as a cursor in `BEGIN TRANSACTION READ ONLY` (always rolled back) over the extended protocol, with `SET LOCAL statement_timeout`, and fetches only `maxRows + 1` rows.

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

   Add tests for anything kind-specific (views, type mapping, quoting) in the same file.
4. Register the kind in `builtInDrivers` (`src/drivers/index.ts`). The admin UI ("Add <label>") and the App Core pick it up from there.
