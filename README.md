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
| `MONGO_URL` | web, worker | Required outside compose. Compose always uses `mongodb://mongo:27017`. |
| `MONGO_DB` | web, worker | Database name. Default `botley`. |
| `WEB_PORT` | compose | Host port for plain-http `web`. Default 3000. |
| `SITE_ADDRESS` | compose (caddy) | Hostname for the `https` profile. |

Process config is parsed and validated in `src/server/config.ts`. Add new variables there and to `.env.example`.

## Develop

Node 24 and Docker (tests start a real MongoDB with Testcontainers).

```sh
npm install
docker run -d --name botley-mongo -p 27017:27017 mongo:8   # or any Mongo
MONGO_URL=mongodb://localhost:27017 npm run dev            # web on :3000 (reads .env)
MONGO_URL=mongodb://localhost:27017 npm run dev:worker     # worker (tsx watch, reads .env)

npm test            # vitest; starts mongo:8 via testcontainers (or set MONGO_TEST_URL)
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
    errors.ts      AppError subclasses (WrongWorkspaceError, ForbiddenError, NotFoundError)
    users/         Slack sign-in, roles, requireAdmin
    preferences/   Per-user UI preferences (theme)
    testing/       Test harness: real Mongo, FakeClock, InMemorySlackGateway, MockLlm
  adapters/        Production implementations of ports (system clock, ...)
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
test/global-setup.ts   Starts MongoDB once per test run
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

Events wired so far: idle by default, `thinking` while sign-in or sign-out is pending, `success` right after sign-in, `error` on the sign-in error, the forbidden page and the `error.tsx` boundaries, and `empty` on the admin placeholder and the 404 page. Chat (thinking/answering), Data Source tests and Reports should hook in as described above when they are built.

The Slack avatar `public/botley-avatar.png` (1024 px) is rendered from `public/botley.svg`. After changing the SVG, re-render it with any SVG rasteriser, e.g. `@resvg/resvg-js`: `new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } }).render().asPng()`.
