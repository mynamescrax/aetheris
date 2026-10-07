// TMDB goes through the server's /api/tmdb passthrough so the key stays
// server-side. Every provider must go through /movie-proxy (see CLAUDE.md for
// per-provider status).
var TMDB_IMG = "https://image.tmdb.org/t/p/w342";
var TMDB_API = "/api/tmdb";

// Set by /movie-relay-config.js when the relay runs on its own origin, so
// provider script never runs on the main site. Empty means same origin.
var MOVIE_RELAY_ORIGIN =
  typeof window.MOVIE_RELAY_ORIGIN === "string"
    ? window.MOVIE_RELAY_ORIGIN
    : "";

function relayUrl(upstream) {
  return (
    MOVIE_RELAY_ORIGIN + "/movie-proxy?url=" + encodeURIComponent(upstream)
  );
}

var MOVIES_SOURCES = [
  {
    // Media CDN currently serves the VPS a Cloudflare challenge.
    name: "VidSrc (vidsrcme.ru)",
    url: function (t, id, s, e) {
      return relayUrl(
        "https://vidsrcme.ru/embed/" +
          (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e),
      );
    },
  },
  {
    // Works when a title has a swish (2vcdn.skin) server; others can hit
    // hosts that block the VPS.
    name: "2Embed (2embed.cc)",
    url: function (t, id, s, e) {
      // 2Embed wants "&s=" here; "?s=" is ignored and always plays S1E1.
      return relayUrl(
        t === "movie"
          ? "https://www.2embed.cc/embed/" + id
          : "https://www.2embed.cc/embedtv/" + id + "&s=" + s + "&e=" + e,
      );
    },
  },
  {
    // Media CDN currently rejects the VPS (403/429/401).
    name: "VidSrc.to (vidsrc.to)",
    url: function (t, id, s, e) {
      return relayUrl(
        "https://vidsrc.to/embed/" +
          (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e),
      );
    },
  },
  {
    // Playback not verified end to end yet.
    name: "VidSrc.pm (vidsrc.pm)",
    url: function (t, id, s, e) {
      return relayUrl(
        "https://vidsrc.pm/embed/" +
          (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e),
      );
    },
  },
  {
    // Default source. Full watch pages, not an embed; needs the relay to
    // forward its signed X-Api-Key/X-Request-* headers.
    name: "Flixer (flixer.su)",
    url: function (t, id, s, e) {
      return relayUrl(
        "https://flixer.su/watch/" +
          (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e),
      );
    },
  },
  // Not listed because they don't work from the VPS: SmashyStream, VidLink,
  // Embed.su, VidEasy, AutoEmbed, VidSrc.cc, hls.lol and lul. The last two
  // can be re-added via hls-player.html (/hls-resolve) if that changes.
];
