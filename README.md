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
- **chat**: DMs with accounts
- **ai**: chat and image gen through any OpenAI-compatible API
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

`deploy.sh` does the whole update on the server: pulls `main`, installs deps, runs lint and tests, validates and installs the Caddyfile, reloads Caddy, restarts the PM2 app and checks it answers. set `SKIP_CHECKS=1` to skip lint/tests.

```bash
./deploy.sh
```

## development

```bash
pnpm start     # node index.js (pass --env-file=.env if you want your config)
pnpm lint      # eslint
pnpm check     # syntax-check every script, inline <script> and catalog JSON
pnpm test      # node --test
```

## credits

Game files from [GN-Math](https://gn-math.dev) and [The Ultimate Game Stash](https://docs.google.com/document/d/1_FmH3BlSBQI7FGgAQL59-ZPe8eCxs35wel6JUyVaG8Q/preview). if you fork this, a star would be appreciated!

## license

AGPL-3.0-or-later - see [LICENSE](LICENSE).
