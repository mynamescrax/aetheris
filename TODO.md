# TODO

## Movies: still to verify live

The relay work is done (see CLAUDE.md for provider findings). What's left is
checking it on production:

- [ ] Homepage still renders with movie-related cookies, local storage and a
      cached service worker present.
- [ ] Regular pages and existing proxy/game routes are unaffected.
- [ ] All movie sources play in a clean iPad-like browser context.
- [ ] Playback starts and seeking works (manifests, keys, segments, Range).
- [ ] Close/reopen the modal, switch sources, test movie and TV URLs.
- [ ] After deploy: Caddy reload succeeds, PM2 shows `aetheris` online, `/`,
      `/movies.html` and every movie proxy route work live.
- [ ] Roll back immediately if the homepage or unrelated routes resolve to a
      movie provider.

## Proxy: still to verify on real devices

- [ ] iPad Safari: launch a proxied game, background the tab a few minutes,
      come back and hit "Try again" - should recover without a reload.
- [ ] iPadOS 14.x / 15.0-15.3: controller boots and a proxied page loads
      (`Object.hasOwn` / `BroadcastChannel` shims).
- [ ] Chromebook: block `/libcurl/index.mjs` in DevTools and confirm the
      epoxy fallback still launches a game.
- [ ] Slow 3G: transport timeout gives a fallback or an error, not an endless
      spinner.
- [ ] Large proxied page starts rendering before it's fully downloaded, with
      the panic-key/audio shims still in `<head>`.
- [ ] Real iPad pass over the UI: navigation/back/forward, favorites, backup
      export/import via Files, cache reset keeps saves, chat, AI, reports.

## Ideas / known gaps

Each of these needs a product decision or live testing first.

- Raise the registration password minimum (currently 4 chars, `index.js`).
- `data-transfer.js` builds the whole export JSON before checking the 128 MB
  limit, so a huge save can OOM before the guard runs.
- `movie-relay.js` only rewrites quoted `src`/`href`/`data-src`/`data-api`;
  `srcset`, `action`, `poster` and unquoted attributes fall through.
- `/movie-proxy` is an unauthenticated, CORS-wide forward relay with a small
  blocklist. An upstream allowlist or auth gate would close it, but could
  break working providers.
- `lc-relay` has no per-socket message-rate limit (frames are capped at 1 MB,
  backpressure terminates at 4 MB buffered).
- The on-demand TLS `ask` matcher accepts any `*.aetheris.win` / `*.crax.lol`
  subdomain. Low risk (needs DNS control); an exact allowlist is stricter.
- `sw.js` restores the desktop-UA spoof flag asynchronously, so early
  requests can miss spoofing.
- No transport liveness probe: a dead transport behind a still-connected frame
  only recovers when the user retries.
- AI model menu: no arrow-key navigation / listbox role.
- `theme.js` `applyTheme()` doesn't persist the choice itself.
- Proxy content runs same-origin with the site; a separate origin for proxied
  content would be real isolation.
- The app keeps accounts in per-user JSON files: run one instance per
  `database/` directory.
