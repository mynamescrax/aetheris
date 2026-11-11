# Aetheris development notes

## Overview

Node/Fastify app behind Caddy. Production runs from `/var/www/aetheris` under
PM2; Caddy uses the repo's `Caddyfile` as `/etc/caddy/Caddyfile`.

- `index.js` - Fastify app: APIs, WebSocket/Wisp, static files.
- `lib/game-catalogs.js` - cached server relay for the live provider game
  catalogs (`/api/games/catalog/:source`); the client merges them into one
  library (`public/assets/data/games.js`).
- `movie-relay.js` - server-side relay behind `/movie-proxy`.
- `lib/tiktok-gateway.js` - in-process TikTok gateway under `/tiktok` (raw
  request handler before Fastify, plus the `/tiktok/tt-ws` upgrade).
- `lib/tiktok-cookies.js` - scoped TikTok cookie jar (`aetheris_tt_` prefix).
- `public/tiktok.html` / `public/js/tiktok-client.js` - TikTok area UI and the
  injected URL/cookie hook.
- `Caddyfile` - public routing and server-side reverse proxies.
- `public/movies.html` - Movies & TV UI and provider selection.
- `public/js/scramjet-init.js` - browsing-proxy bootstrap for games/apps.
- `deploy.sh` - pulls `main`, installs deps, runs lint/tests, installs the
  Caddyfile, reloads Caddy, restarts PM2, health-checks.
- `notes.md` - server ops notes (gitignored, local only).
- `TODO.md` - open work.

## Rules

- Don't deploy unless the user explicitly asks.
- Don't commit or push unless the user asks, or asks to deploy.
- Preserve unrelated working-tree changes.
- Use `apply_patch` for manual file edits.
- After code changes run `pnpm lint`, `pnpm test` and `git diff --check`.
- Stamped `/css/` and `/js/` URLs (`?v=`) are cached for a year
  (`immutable`). After changing anything in `public/css/` or `public/js/`,
  run `pnpm stamp` instead of editing stamps by hand: it gives each changed
  file a new stamp everywhere it's loaded (pages, `sw.js`, `movie-relay.js`)
  and records its hash in `tests/asset-stamps.json`. `pnpm test` fails until
  you do.
- Validate Caddy changes before deploying:

  ```sh
  Get-Content Caddyfile -Raw | ssh craxvps "caddy validate --adapter caddyfile --config /dev/stdin"
  ```

- A deploy isn't done until the affected live routes are tested.
- Movie playback: test with an iPad/Safari UA and capture failed requests from
  nested frames. A `200` on the first embed document doesn't prove playback.
  Frame counts don't prove content either - screenshot-verify.

## TikTok gateway constraints

- `handleTikTokRequest` runs on the raw HTTP server before Fastify so request
  bodies (gzipped JSON), `Range`/`206` and the WebSocket upgrade keep working.
  Don't move it behind Fastify's body parser.
- TikTok's router reads `location.pathname`, so default-host pages are masked
  to real root paths (`/foryou`, `/@user`) rather than `/tiktok/...`. Those
  paths are only claimed while the `aetheris_tt` marker cookie is present, and
  only for the `TIKTOK_NAV_RE` allowlist. Don't widen that list to site routes;
  `/settings.html`, `/api/*`, etc. must always stay with Fastify.
- Root nav requests redirect into `/tiktok/tt?url=...` so the document loads
  under `/tiktok` (relative asset URLs and the masked client), then the client
  `replaceState`s back to the root path the router expects.
- Upstream cookies are namespaced `aetheris_tt_` with `Path=/`, and the gateway
  strips the prefix before forwarding. Site cookies are never sent upstream,
  and the prefix prevents name collisions; don't switch the path back to
  `/tiktok` or masked root pages lose the jar. The injected client does the
  same renaming for `document.cookie` writes.
- Same-origin by design: TikTok JS can read the site's localStorage. Don't put
  secrets there (the DM token currently lives in localStorage). A subdomain is
  the only real isolation.
- Rewritten JS/CSS is cached in memory for 10 minutes (32 MB cap, `X-TT-Cache:
  hit` on hits). Keep the key as the upstream URL; the rewritten body depends
  on that URL, not on the page that requested it.
- After changing `public/tiktok.html` or `public/js/tiktok-client.js`, run
  `pnpm stamp` (the client/page loader stamps are checked by tests).

## Movies proxy constraints

- Movies use server-side proxying (`/movie-proxy`), not Scramjet or the
  browsing proxy. Don't add Scramjet/controller/service-worker dependencies
  to `movies.html`.
- Providers usually return wrapper pages that load another player origin,
  root-relative assets, APIs, HLS manifests, keys, subtitles and segments
  from changing CDN hosts.
- Stock Caddy can rewrite response headers but not HTML/JS/JSON/HLS bodies
  without an extra module.
- `handle_path /proxy/provider/*` strips the prefix. A proxied document that
  references `/assets/file.js` makes the browser fetch
  `https://aetheris.win/assets/file.js`, not `/proxy/provider/assets/file.js`.
- Never route root requests by a shared cookie or broad Referer matcher. It
  hijacks the whole site after a movie loads - this once made the homepage
  render `streamingnow.mov`.
- Don't hard-code rotating media CDN hostnames as the only fix.
- `/movie-proxy` keeps a small in-memory LRU of immutable media bodies
  (`MOVIE_SEGMENT_CACHE_MB`, default 192; `MOVIE_SEGMENT_TTL_MIN`, default 15)
  and coalesces concurrent requests for the same URL into one upstream fetch.
  Deterministic failures (400/401/404/410) are answered locally for 60s, 403
  for 15s unless it's HTML (Cloudflare challenges clear on their own). Range
  requests and bodies over 24MB stream as before. Hit/miss counters log every
  10 minutes of activity; cached responses carry `x-movie-cache: hit|coalesced`.
- Changing `Origin`/`Referer`/CSP/frame headers doesn't fix an upstream that
  blocks the VPS IP.
- A previous movie fix was fully reverted (commits `3cf60bbe`..`8cfd2243`).
  Don't reintroduce that design.

## Provider findings

Providers change constantly; recheck before relying on any of this. "VPS
block" below means the upstream rejects the production VPS egress and no
header change fixes it.

**2026-09-03**

- `vidsrc.to` wraps its player at `vsembed.ru`, which requests root-relative
  `/assets/sbx.js` and `/vs_src.php?type=movie&id=...`.
- `www.2embed.cc` wraps a player at `videm.xyz`.
- `multiembed.mov` (SuperEmbed) redirects to `streamingnow.mov`, which returns
  `403` to the VPS but `200` from a residential connection. VPS block.
- `vidsrcme.ru` plays via `cloudorchestranova.com` (player) +
  `zenithofzircon.space` (HLS). Embed pages, `generate.php` and
  `master/index.m3u8` proxy fine, but every `/content/.../page-N.html` segment
  gets a Cloudflare "Attention Required" challenge (`403`,
  `server: cloudflare`) for non-browser clients, even with a real browser UA.
  The player then retry-storms `generate.php` (`429`), `master.m3u8` (`401`)
  and reloads in a loop. VPS block (observed from a local connection).

**2026-09-08**

- Direct-embed fallback removed: every provider goes through `/movie-proxy`.
  Challenged providers stay unavailable until their CDN accepts the VPS or a
  second server-side egress is added.
- 2Embed -> `videm.xyz` (`Server VNE`): embed page, `api.php`
  (`race`/`play`/`sources`, `200 application/json`) and `_stream` playlists
  proxy fine, but every segment from ByteDance ImageX
  (`p16-ttam-va.ibyteimg.com`) returns `{"code":1004,"error":"domain forbidden"}`
  (`403`) regardless of Referer/Origin/UA. Verified by a full curl replay of
  the signed chain from the VPS; no cookies involved. VPS block. 2Embed stays
  proxied per user preference.

**2026-09-28**

- 2Embed now wraps a swish/`2vcdn.skin` player (server 1) or a `vidsrc.buzz`
  player (other servers). Five relay/client bugs fixed:
  1. JWPlayer base rewrite no longer appends a `#/jwplayer.js` fragment. JW
     derives its webpack base with
     `src.slice(0, src.lastIndexOf("/jwplayer.js")+1)`, so the fragment sent
     every chunk request to the jwplayer.js proxy URL (`provider.hlsjs.js` /
     `vast.js` 404, setup Error 104153). The relay now appends a literal
     `/jwplayer.js` after the percent-encoded upstream directory.
  2. The relay client re-anchors same-origin URLs built from
     `script.src`/`document.baseURI` onto the upstream origin (fixed
     `/player/jw8/vast.js` being fetched from aetheris.win).
  3. Relay CSP allows `image.tmdb.org` for artwork set via CSS/JS strings the
     URL hooks can't see.
  4. Doctype injection removes quirks mode (e.g. 2vcdn.skin).
  5. The relay refuses the TikTok ad-image "segments" in 2vcdn's decoy hls4
     playlist (`isDecoyAdImage` in `movie-relay.js`). Otherwise they buffer
     fine, hls.js plays a black video with a moving clock, and the page's
     hls4 -> hls3 fallback never fires. With the fix it falls back within
     seconds and the real signed hls3 stream plays through the relay.
- Still VPS-blocked: `tagivi.com` (Cloudflare 403),
  `unfortunatelyejectinflected.com` (403), `relay3.videm.xyz` (429 bursts),
  some signed segment URLs (404).
- Titles whose 2Embed servers all funnel to a blocked host still fail, e.g.
  UNABOMBER tmdb=1492640: no swish server, vidsrc.buzz/Videm-direct both hit
  `relay3.videm.xyz` 429s, Vcr is dead, and VidSrc.to's new
  `filamentoffable.space` CDN returns 403/429/401. Workaround: switch source
  or retry later.
- The swish path was verified playing real video through the relay, so 2Embed
  replaced VidSrc.to as the default; VidSrc.to is the fallback. If a 2Embed
  server regains VPS access, no code change is needed.

**2026-09-29**

- Provider sweep (VPS egress + Playwright playback through the live relay,
  Backrooms tmdb=1083381), all rejected:
  - `vidsrc.xyz`, `embed.su`, `cineby.at`, `vidking.net`: DNS dead.
  - `vidlink.pro`: Cloudflare 403.
  - SuperEmbed: redirects to `streamingnow.mov` (CF challenge); VIP endpoint 404s.
  - VidCore: app never calls `/api/sources` (error state, dead video).
  - `vidzee`: loads but builds no player.
  - `vidsrc.dev`: parked (sedoparking).
  - `cinesrc.st`: loads, but its stream API `a.cineflix.st` 502s.
  - `vidsrc.sh`: same challenged `cloudorchestranova` chain
    (`sartorialsupernova.space` 403/429/401).
  - `embos.top`: resolves no stream.
  - `ployan.me`: needs opaque per-session tokens.
  - 123moviesfree: their own player JS 404s.
  - `cineby.ws`: 404s on all watch paths.
  - `player.videasy.to`: flaps 403 to non-browser clients (curl 200, headless
    Chromium always 403, relay flaky). Too unreliable.
- hls.lol removed. The chain resolves and serves 200s end to end, but
  screenshots showed the video is an "atlantic.st disable Cloudflare Warp VPN"
  slate for every title, because the VPS egress is flagged as datacenter/VPN.
  Dropdown entry removed (back to 4 sources); `/hls-resolve` and
  `hls-player.html` stay, tested, in case egress reputation changes.
- lul/aether rejected (throttled). P-Stream `lul.aether.cx` lookup and
  worker-signed `*.tnmr.org` masters resolve (200) and single requests work
  from the VPS, but follow-on playlist/segment requests 403 more often than
  not; two screenshot-verified trials gave zero frames. Likely burst
  throttling, maybe plus fast signature expiry. Entry removed; route kept for
  a re-test after a long cooldown.

**2026-10-08**

- Flixer is the default and takes ~95% of plays. PM2 log: its stream CDN
  `serve.dragonballzfans.xyz` 400s ~15% and `shrek.dragonballzfans.xyz`
  503s ~33%, with the same `data=` segment requested 3x in a row: burst
  throttling of the single shared VPS IP. Flixer/Hexa's backend is built for
  the viewer's residential IP, so this is structural.
- Flixer polls `version.json` ~12x per play, POSTs `api/send` (405) and
  loads YouTube trailers. The relay now answers trackers/YouTube/`api/send`
  locally (`localAnswer`) and caches `version.json` for 60s.
- The relay retries a `503`/`429` GET once (Retry-After, max 3s).
- `vidsrc.su` (Hexa clone) builds its API host as `"themoviedb." +
  location.hostname`; the relay maps `*.<our host>` back onto the referer's
  host (`remapOwnSubdomain`). Re-test vidsrc.su after deploy.
- The iframe `load` event fired for 562/580 Flixer plays and the old 20s
  timeout fired once, so it said nothing about playback.
  `movie-proxy-client.js` now posts `aetheris-movie-playback` messages
  (`armed` / `ready` / `playing` / `error`, feature-length videos only, >=
  300s) to every ancestor. `movies-ui.js` auto-switches to the next untried
  source after 30s with no `ready`, 90s once a video is `armed` (waiting for
  a tap) and 45s after the user clicks into the player. New beacons:
  `ev=ready|playing|timeout|autoplay|exhausted`, so per-source success rates
  can now be counted from the log.
- Probed from the VPS: vidfast.vc loads but shows "Please Disable Sandbox"
  through the relay; hexa.su (same backend as Flixer, lighter frontend)
  shows a Cap "Verify you're human" check; vidbolt.pro never requests a
  stream; vidsrc.mov wraps the blocked vsembed/cloudorchestranova chain;
  vidsrc.cc, vidlink.pro, vidfast.pro are Cloudflare 403; vidking,
  111movies, rivestream, autoembed, moviesapi, vidsrc.xyz/.net/.in/.icu,
  rgshows are DNS-dead; vidjoy is parked.
- Relayed pages are same-origin with the site, so a frame-busting script
  can navigate the whole site (seen with a Wikimedia test page). The player
  iframe has no `sandbox` because providers refuse sandboxed frames.

**2026-10-11**

- Provider sweep (Playwright, player iframe on aetheris.win -> live
  `/movie-proxy`, so upstream egress is the VPS). Titles: Fight Club 550,
  Inside Out 2 1022789, The Godfather 238, GoT 1399 S1E1, The Last of Us
  100088 S1E1. Played: Flixer 4/5, VidSrc.su 4/5 (both dragonballzfans; both
  fail TLOU), 2Embed 4/5 and VidAPI 4/5 (both videm; both fail Inside Out
  2; start in 21-33s), VidRock 3/5 (boomchick; `*.lol` hosts 403 the VPS).
  Flixer + 2Embed covered all five.
- Played nothing: vidsrcme.ru, vidsrc.pm, vidsrc.to, vidsrc.wtf, vidzee,
  videasy.to, autoembed.co, hexa.su, spencerdevs, cinemaos, primesrc,
  nontongo. Removed the first three from the list.
- Source order is now Flixer, 2Embed, VidRock, VidSrc.su, VidAPI (CDNs
  alternate). `WATCHDOG_MS` 30s -> 45s and `INTERACTION_MS` 45s -> 60s,
  because 2Embed/VidAPI were being cut off before they started.
  `sourceDefaultVersion` bumped since indexes changed.
- PM2 log over 2 days: one client re-requested a single expired shrek
  `proxy?data=` URL 24,778 times (400); 400s from dragonballzfans are
  permanent, not transient.

**2026-11-02**

- Evaluated `vidy.st`. Its docs describe a drop-in iframe player:
  `/movie/{tmdbId}` and `/tv/{tmdbId}/{season}/{episode}`. The page is
  Next.js and the player probes ~18 provider servers (`miami`, `boise`,
  `chicago`, ...) through `api.wecollege.net`; `movy.sx` is the catalog
  frontend for the same backend (its footer API link points at `vidy.st`).
  It is **not** listed as a source: `api.wecollege.net/seed` answers the VPS
  with a Cloudflare "Attention Required" `403` (`server: cloudflare`), while
  a residential connection plays fine. If the VPS egress ever clears, the
  entry is a two-line `relayUrl("https://www.vidy.st/...")` addition.
- Two relay bugs found while testing Vidy (fixes kept, they help any newer
  Next.js provider):
  1. Next.js assigns a `TrustedScriptURL` (not a string) to `script.src`, so
     `movie-proxy-client.js`'s hook returned it unchanged and every dynamic
     `/_next/static/chunks/*` load went to our own origin (404, no hydration).
     `toProxyUrl` now stringifies non-string URL objects first.
  2. The relay's final text branch forced `application/octet-stream`. Vidy's
     encrypted `/sources` response is `text/plain`, so its `ofetch` client
     parsed the body as a Blob, the decrypt step rejected every server, and
     the UI ended on "This title isn't available". Unknown bodies now keep a
     `text/*` content type and only fall back to octet-stream otherwise.
- Local Playwright check through the relay (before the VPS block was known):
  Fight Club (tmdb 550) played `index-s1080p-v1-a1.m3u8` from
  `moon.goldenkite.top`, duration 8349s, video `readyState 4`, and GoT
  (tmdb 1399 S1E1) played with the correct episode. Production playback was
  rechecked after deploy and stopped at the `403` on `/seed`, hence removal.
- Movy's own `/movie/{id}?play=true` page renders a catalog hero and needs a
  second manual play click; it was not verified to deep-link TV episodes, so
  it stays out of `MOVIES_SOURCES` too.

## Proxy (Scramjet) notes

- Wisp runs through `lib/wisp-engine.js`: wispurr (Go) worker processes by
  default (`WISP_WORKERS`, default 2, loopback ports from `WISP_PORT` 4432),
  respawned with backoff, with in-process wisp-js answering whenever no
  worker is up. `WISP_ENGINE=wisp-js` forces the old server. The npm linux
  binary is musl-linked: Ubuntu needs `apt install musl` or it logs "can't
  run here" and stays on wisp-js (`deploy.sh` installs musl when missing).
  Falling back logs `[wisp] WARNING no wispurr worker is up` (once a
  minute). `/wisp-status` (loopback only) reports the live engine, and
  `deploy.sh` runs `scripts/wisp-check.js` after the restart: a real Wisp
  stream to example.com; exit 1 fails the deploy, exit 2 warns that it's on
  the wisp-js fallback. wispurr's hostname blacklist is
  exact-match only; subdomains of blocked adult sites rely on the 1.1.1.3
  family DNS.
- Movie source health: `/movie-ping` UI beacons feed `lib/movie-report.js`,
  which posts to `MOVIE_WEBHOOK_URL` (Discord) every `MOVIE_REPORT_HOURS`
  (default 24) plus an instant alert when a source fails for 3+ visitors
  (8+ failures) in an hour with no plays. Tallies persist across restarts
  in `movie-report.json` (gitignored).
- Scramjet runs with `allowFailedIntercepts` + `allowInvalidJs` (scripts the
  rewriter can't parse pass through instead of failing).
- Every source is proxied, aetheris game pages included (`load.js`; only an
  item with `noProxy` is iframed directly). A same-origin game page is what
  scramjet normally refuses (`parseRequest` aborts "attempted to fetch from
  same origin"), so `index.js` drops that guard with a `patchsource` patch and
  `scramjet-init.js` answers the page's same-origin GET/HEAD requests from the
  page itself instead of the transport. That keeps wisp out of loopback (a
  local dev server is unreachable) and off our own public host/Cloudflare,
  and it is the only path where the service worker's game-page cache and
  shims run. The same hook fetches a local game's CDN files (`RELAYED_HOSTS`,
  kept in sync with `MIRROR_HOSTS` in `sw.js` by a test) from the page, so
  the worker's `/s/` mirror redirect still applies: jsDelivr 403s some split
  files (`.part2`, …) that the GitHub mirror serves. If a dependency bump
  makes the guard patch miss, every aetheris game fails with the same-origin
  error; `tests/api.test.js` fails in that case.
- A synchronous XHR never reaches the service worker, so a rewritten `/~/sj/`
  URL can never answer one. Some games depend on it: 1games' GM SDK fetches
  its `keysigned` signature that way and locks the game ("Game is locked: Get
  Veryfied Signature is not called") when it fails, and Unity's lazy file
  loader uses sync HEAD/GET too; the pinned bundle also guarded the path with a
  non-existent `client.getFlag()`, so `send()` threw. The serve-time patch
  resolves every sync request to its real absolute URL (rewrite+unrewrite
  keeps the query and applies `<base>`) and sends it natively. A remote proxied
  page must not reach our own origin that way, so those requests stay rewritten
  and keep the old ignore-and-warn behaviour; an aetheris-served game may use
  our origin, which is its static host.
- A proxied game frame's `localStorage` is virtualized per proxied origin, so
  the game-clock shim gets its offset from
  `window.__aetherisGameClockOffset`, set by the frame init hook in
  `scramjet-init.js` (it reads the real localStorage from the player page and
  refreshes it once a second).
- Firefox enforces `Content-Length` on responses a service worker hands back;
  Chrome ignores it. Scramjet rewrites document/script/style/worker bodies
  (a Unity framework worker blob grows from ~92KB to ~160KB) but forwards the
  upstream length, so on Firefox that worker was truncated mid-code and the
  game hung after its assets had loaded. `sw.js` drops `content-length` from
  rewritten destinations (and `blob:`/`data:` targets), and
  `scramjet-init.js` drops `content-encoding`/`content-length` from the page's
  own fetch responses (their bodies are already decoded). Binary passthrough
  (`.unityweb`) keeps its length so Unity's progress bar still works.
- `index.js` serves the pinned scramjet/controller bundles with serve-time
  patches (`patchsource`) for fixes that landed upstream after alpha.2 but
  were never published: history's undefined-url, SRI/integrity stripping,
  percent-encoded blob/data paths, anchor `toString` + `img.currentSrc`
  unrewriting, the location-proxy `tryset`, and a snapshot-bound
  `String.prototype.startsWith` for the URL rewriter. If a dependency bump
  removes an anchor, the server logs `[scramjet-patch] <label> pattern not
  found` and serves that snippet unpatched.
- YouTube's HTML pages send header blocks larger than the 16 KB
  `SETTINGS_MAX_HEADER_LIST_SIZE` hyper advertises, so epoxy's h2 client
  resets the stream and the frame shows `Internal Service Worker Error: ...
  Http2 ... Reset(StreamId(1), PROTOCOL_ERROR, Library)`. When epoxy is active,
  `scramjet-init.js` sends `youtube.com` / `youtu.be` / `youtube-nocookie.com`
  through a lazily started libcurl transport; media/API hosts stay on epoxy.
  If libcurl can't start (Apple), the original error stands. epoxy exposes no
  option for the h2 header-list limit.
- `sw.js` blocks proxied subresources on the HaGeZi LIGHT list
  (`public/assets/data/adblock-domains.txt`, refresh with
  `node scripts/update-adblock.js`, then bump `ADBLOCK_LIST_VERSION`) plus a
  curated `AD_HOSTS_BUILTIN` set of ad networks (Google IMA/AdX, Prebid,
  app-ads SDKs, popunders): LIGHT deliberately omits hosts that ad-funded
  games load, so on its own it left game ads running. Top-level navigations
  are never blocked; subframe navigations (`destination === "iframe"`) are,
  which is how a game's ad iframe is stopped. A per-host brake delays repeats
  past 20/s (CNN's video-ad fallback looped ~2000/s on instant failures).
  Proxied URLs are `/~/sj/<tab>/<frame>/<encoded url>`. Users can turn it off
  in settings (`proxyAdblock`). The in-frame adblocker in `load.html` also
  removes ad nodes/iframes and blocks ad `fetch`/XHR/`window.open`.
- The scramjet/controller bundle URLs carry `PROXY_ENGINE_VERSION`
  (`scramjet-init.js`, passed to the Controller config for the injected
  copies too). Bump it whenever the serve-time patches in `index.js` change:
  without it a browser or Cloudflare copy cached before the deploy keeps the
  old bundle (the same-origin guard then breaks every aetheris game until the
  cache expires). Versioned bundle URLs are served `immutable`; unversioned
  ones `no-store`, because Cloudflare's Browser Cache TTL would otherwise
  give an old copy a 4-hour life. `load.js` also reloads once if a frame
  shows the same-origin error, so an already-cached client recovers.

## Game asset relay

`lib/game-assets.js` serves every game build the visitor asks for. The
service worker sends absolute CDN URLs there, so a game loads from the VPS
instead of the CDN.

- A build that is too big to keep in memory (a 30MB Unity wasm) is streamed
  to the visitor and written to the disk cache at the same time. The next
  visitor gets it from the disk: no upstream bandwidth, and a `Range` request
  resumes where the last one stopped. The cache lives in `cache/` (gitignored),
  defaults to 4GB and 24 hours: `GAME_ASSET_CACHE_DIR`,
  `GAME_ASSET_DISK_CACHE_MB`, `GAME_ASSET_DISK_CACHE_MIN`.
- An upstream that stops sending halfway does not end the transfer. The bytes
  the visitor already has stay with them and the next mirror is asked for the
  rest with a `Range` header. A mirror that ignores the header sends the file
  again and its first bytes are dropped, so nothing is duplicated.
- The stall guard gives up after `GAME_ASSET_STALL_MS` (default 20s) without
  a byte. It used to be 45s, which left the visitor staring at a frozen
  progress bar.
- A streamed build is sent with the `Content-Length` the upstream gave, but
  only when the upstream body was not compressed. The Unity loader warns
  "Response is served without Content-Length header" and shows a progress bar
  that never moves without it. A compressed body was decoded on the way in, so
  its length describes the compressed bytes: sending it would cut the build
  short.
- A visitor that walks away mid-build leaves no temp file behind; the cache
  holds finished builds only, and stale temp files are swept on startup.
- A path that pins a commit (`@<40-hex>`) gets
  `Cache-Control: public, max-age=31536000, immutable`; a moving ref
  (`@main`) keeps `max-age=300`. The pinned builds are the big ones, so the
  browser stops pulling 30MB every five minutes.
- `HEAD` never downloads the body: split-file loaders ask for the size of
  every part first, and buffering that cost 160MB of pointless traffic.
- GitHub links are relayed like jsDelivr: `raw.githubusercontent.com` uses the
  `ghraw` mirror, and every other `*.githubusercontent.com` host
  (`objects.`/`media.`/`gist.`/`user-images.`/`private-user-images.`, …) uses
  `ghuc`, which carries the host in the relayed path. Signed release/private
  URLs keep their query string (it is part of the cache key). The worker also
  translates `github.com/<u>/<r>/raw/…`, the `blob/…?raw=true` form and
  `gist.github.com/…/raw/…` before redirecting, so those never leave for
  github.com. Release *download* URLs still rely on GitHub's 302, so the relay
  does not follow those.

## Game pages

- The game pages are static files under `public/assets/games/`. One of them
  (`unonomercy.html`) is 34MB, so it is the slowest thing on the site.
- Cloudflare does not cache HTML by default, so every visit pulled the whole
  page from the origin. Two things fix that:
  - the browser keeps it for a day
    (`Cache-Control: public, max-age=86400, stale-while-revalidate=604800`),
  - the service worker keeps its own copy in the `aetheris-gamepages` cache
    (16 entries) and serves that while a fresh one is fetched in the
    background.
- A Cloudflare cache rule for `/assets/games/*` would fix the first visit too.
  That needs the dashboard; the code cannot do it.
- The "Game clock" setting (`gameClockOffsetMs` in localStorage) shifts `Date`
  inside `/assets/games/*` pages by up to ten years so day-based timers (daily
  rewards, streaks) can be claimed again. `sw.js` injects the shim at the top
  of `<head>` after the page caches, so no cache version bump is needed. It
  re-reads the offset about once a second, so an open game follows a change
  made in another tab. Other proxy pages are not patched and keep the real
  clock. Aetheris pages are proxied now, so the shim gets the offset from
  `window.__aetherisGameClockOffset` (scramjet virtualizes `localStorage` in
  the frame); `scramjet-init.js` keeps it current.

## Production access

- SSH alias: `craxvps`
- App directory: `/var/www/aetheris`
- Deploy command on the server: `deploy`
- PM2 app name: `aetheris`

Deploying is an external state change: validate first, deploy only with
authorization, then check the homepage and every changed route.
