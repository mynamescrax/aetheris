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
  // Ordered so each fallback pulls video from a different CDN than the one
  // before it (Flixer + VidSrc.su share dragonballzfans; 2Embed + VidAPI share
  // videm). Verified playing through the relay from the VPS on 2026-10-11.
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
  {
    // Slow to start (~20-30s). Video from videm.xyz / vidsrc.buzz.
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
    // Video from boomchick.org; some titles hit hosts that 403 the VPS.
    name: "VidRock (vidrock.net)",
    url: function (t, id, s, e) {
      return relayUrl(
        "https://vidrock.net/" +
          (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e),
      );
    },
  },
  {
    // Same dragonballzfans CDN as Flixer, but a different page/API.
    name: "VidSrc.su (vidsrc.su)",
    url: function (t, id, s, e) {
      return relayUrl(
        "https://vidsrc.su/embed/" +
          (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e),
      );
    },
  },
  {
    // Same videm CDN as 2Embed; slow to start (~25-35s).
    name: "VidAPI (vidapi.xyz)",
    url: function (t, id, s, e) {
      return relayUrl(
        t === "movie"
          ? "https://vidapi.xyz/embed/movie/" + id
          : "https://vidapi.xyz/embed/tv/" + id + "&s=" + s + "&e=" + e,
      );
    },
  },
  // Not listed because they don't play from the VPS (2026-10-11 sweep):
  // VidSrc (vidsrcme.ru), VidSrc.to, VidSrc.pm, SmashyStream, VidLink,
  // Embed.su, VidEasy, AutoEmbed, VidSrc.cc, VidSrc.wtf, VidZee, Hexa,
  // SpencerDevs, CinemaOS, PrimeSrc, Nontongo, VidFast, VidUp, SuperEmbed,
  // hls.lol and lul. The last two can be re-added via hls-player.html
  // (/hls-resolve) if that changes.
];