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
  // Keep array indexes stable for old saved preferences. fallbackRank controls
  // automatic retries: Flixer -> 2Embed -> VidAPI -> VidSrc.su -> VidRock.
  // All remain selectable. Shared CDNs can still fail together; these ranks
  // reflect the supplied Oct 12-14 reports, not independent availability.
  {
    // Default source. Full watch pages, not an embed; needs the relay to
    // forward its signed X-Api-Key/X-Request-* headers.
    id: "flixer",
    fallbackRank: 0,
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
    id: "2embed",
    fallbackRank: 1,
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
    id: "vidrock",
    fallbackRank: 4,
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
    id: "vidsrc-su",
    fallbackRank: 3,
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
    id: "vidapi",
    fallbackRank: 2,
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