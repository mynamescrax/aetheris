<div align="center">
  <img src="public/assets/images/icon.png" width="80" />
  <h1>Aetheris</h1>
  <p>games, proxy, movies and a chat: all in one place</p>
  <p>open source again after 5 months</p>
</div>

## what's inside

- **games**: big library with search, tags, favorites and a popular section
- **apps**: a handful of web apps
- **proxy**: Scramjet with libcurl/epoxy transports
- **movies & tv**: TMDB search plus a few embed sources
- **tiktok**: a gateway with the real web app, feed and playback, with optional dedicated-origin isolation
- **chat**: DMs and group chats with accounts and brief message notifications
- **ai**: chat through an OpenAI-compatible API; set `AI_CHAT_MODELS` to your provider's allowed chat model IDs. Image generation is unavailable.
- **cheats**: bookmarklets
- **tab cloak**: fake the tab title and icon (Google, Drive, Classroom...)
- **panic key**: one key sends you somewhere safe
- **themes**, **about:blank launch**, **performance mode** and **bug reports** from the home page

## self-hosting

you need a VPS for this: the proxy needs a real server and won't work on Vercel or similar.

**you'll need:** [Node.js](https://nodejs.org) (>=20.19), [Git](https://git-scm.com/download), [pnpm](https://pnpm.io), [PM2](https://pm2.keymetrics.io), [Caddy](https://caddyserver.com)

```bash
git clone https://github.com/mynamescrax/aetheris.git
cd aetheris
pnpm install --frozen-lockfile
```

set up your environment:

```bash
cp .env.example .env
# fill in your values - every option is commented in the file
```

the app listens on `PORT` (default 8080). the Discord webhooks and AI key are optional for the site itself; `monitor.js` won't start without `DISCORD_WEBHOOK`.

start it with PM2:

```bash
pm2 start index.js --name aetheris --node-args="--env-file=$PWD/.env" --kill-timeout 5000
pm2 save
```

hook up Caddy. the `Caddyfile` is the one I run in production, so swap the domains for yours first:

```bash
caddy validate --adapter caddyfile --config Caddyfile
sudo install -m 0644 Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### updating

`deploy.sh` fetches `main` into a private `.releases/` directory without changing
live files. It installs dependencies, runs lint/syntax/tests and validates Caddy
before activation. The new app keeps the original working directory (and its
database, caches and `.env`), but serves code/assets from the staged release.
Only after release-identity and Wisp checks pass does the source checkout advance.

```bash
DEPLOY_HEALTH_HOST=your-site.example ./deploy.sh
```

Use your main HTTPS hostname (`DEPLOY_HEALTH_HOST` defaults to `aetheris.win`).
Deployment installs the validated Caddyfile with the app's `PORT` baked in,
then checks the release through local Caddy with that hostname and TLS certificate.
For a manual Caddy install on a non-default port, set `AETHERIS_PORT` in Caddy's environment.

Failures after activation restore the previous PM2 configuration, active-release
pointer and Caddyfile. Pending storage journals are recovered while the app is
stopped, before older code restarts. `CADDY_CONFIG` can override the default
`/etc/caddy/Caddyfile`; that file and `.env` must already exist. Tracked local
changes and concurrent deployments are refused. `SKIP_CHECKS=1` skips source
checks, not Caddy validation or health checks.

Old releases and owner-only `.deploy-state.*` recovery directories are retained
for inspection/manual cleanup; the latter can contain environment secrets.
Code rollback does not restore earlier database contents or `.env` edits, so
take a backup before deployments that migrate data or configuration.

### isolating TikTok

Create a DNS record for `t.aetheris.win` pointing at your server (or change the
TikTok vhost in `Caddyfile` to your hostname), then configure:

```dotenv
TIKTOK_RELAY_HOST=t.aetheris.win
TIKTOK_EMBEDDERS=https://aetheris.win,https://balf-games.xyz
```

The main page loads a cross-origin frame; that origin serves no account APIs or
site assets. Legacy gateway URLs redirect there, and status messages are checked
against the frame's origin and window. Add every site alias to `TIKTOK_EMBEDDERS`.
When the hostname is unset, legacy same-origin behavior remains for compatibility:
it is **not isolated from account tokens or browser storage**. Deploying the code
alone does not enable isolation; DNS, Caddy and the environment must agree.

## development

```bash
pnpm start     # node index.js (automatically loads .env)
pnpm lint      # eslint
pnpm check     # syntax-check every script, inline <script> and catalog JSON
pnpm test      # node --test
pnpm bench:backend # offline rate-limiter, chat cursor and metadata-cache benchmarks
pnpm bench:storage # local JSON storage throughput, disk reads and event-loop delay
```

The default Wisp tests exercise local routing and worker recovery. Run
`WISP_NETWORK_TESTS=1 node --test tests/wisp-engine.test.js` to also check public
TCP egress, or start the Checks workflow manually. The browser save regression
runs in CI; locally, with Python Playwright and Chromium installed, run
`python tests/browser/save_cleanup.py`.

The backend benchmark compares the optimized hot paths with their previous
full-scan implementations. It uses synthetic data and a local fetch fixture;
the timings measure those operations, not whole-page or production latency.

`pnpm start` loads `.env` before feature modules initialize; existing environment
variables take precedence. Set `MOVIE_SEGMENT_CACHE_MB=0` or
`GAME_ASSET_DISK_CACHE_MB=0` to disable the corresponding cache.

The image relay shares duplicate downloads and allows up to 12 active downloads
(8 per IP), with a bounded queue of 128 (64 per IP). Queued work expires after
10 seconds; overload returns a non-cacheable 503 with `Retry-After`. Disconnecting
the last reader cancels its download without interrupting other readers.

Movie and TikTok relay requests have separate lifetime limits (32/16 and 24/16
global/per-IP by default). Admission happens before request-body buffering, and
streaming keeps its slot until the response closes. Movie requests can queue
128 globally/64 per IP; TikTok queues 256/128. Queues expire after 10 seconds
with a non-cacheable 503 and `Retry-After`. TikTok WebSockets are capped separately
at 128 globally/16 per IP, with a 10-second handshake deadline and 90-second idle
timeout. See `.env.example` for the concurrency settings.

Accounts and chats keep their existing files in `database/`. File operations
are asynchronous, writes replace records atomically, and API responses wait
for writes to finish. Concurrent readers share a disk read but receive separate
objects. Account/group mutations hold their locks through the write; run one
app instance per database directory. The storage benchmark uses temporary
fixture records and removes them afterward.

DM delivery writes both accounts as one journaled batch. Reads wait for its
commit; an interrupted pending batch rolls back at startup, while an already
committed batch is replayed. The app and the recovery command take the same
exclusive local database lock before reading journals. Stop the current app
before starting another with the same database, even on a different port.
On platforms other than Linux and Windows, a crash can leave `database/.writer.sock`;
remove it only after confirming no process is using the database.
If rollback or journal cleanup fails, storage refuses
new work with 503 until recovery rather than exposing divergent conversations.
Keep `database/.transactions/` with the database in backups; do not delete journals.

## credits

Game files from [GN-Math](https://gn-math.dev) and [The Ultimate Game Stash](https://docs.google.com/document/d/1_FmH3BlSBQI7FGgAQL59-ZPe8eCxs35wel6JUyVaG8Q/preview). if you fork this, a star would be appreciated!

## license

AGPL-3.0-or-later - see [LICENSE](LICENSE).
