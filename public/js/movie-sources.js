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

// Order here is the dropdown order; fallbackRank controls automatic retries:
// VidRock -> 2Embed -> VidAPI -> VidSrc.su. Shared CDNs can still fail
// together; these ranks reflect the 2026-11-24 VPS sweep, not independent
// availability.
var MOVIES_SOURCES = [
  {
    // Default source. Video from boomchick.org; started and sustained for
    // movie and TV in the 2026-11-24 sweep.
    id: "vidrock",
    fallbackRank: 0,
    default: true,
    name: "VidRock (vidrock.net)",
    url: function (t, id, s, e) {
      return relayUrl(
        "https://vidrock.net/" +
          (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e),
      );
    },
  },
  {
    // Fast start; worked for movie and TV in the sweep.
    // Some titles hit hosts that 403 the VPS.
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
  {
    // Different page/API on the same dragonballzfans CDN.
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
  // Flixer was removed on 2026-11-24. Its page and APIs still load from the
  // VPS, but the dragonballzfans stream CDN answers 400 to the relay's fresh
  // signed master and every segment; a residential replay fails too, so it is
  // an anti-relay check rather than a VPS-only block. The relay still maps
  // flixer.gd (version.json/RUM/share-dialog fixes) and tests cover it, so
  // re-adding is one entry if that changes.
  //
  // Not listed because they don't play from the VPS (2026-10-11 sweep):
  // VidSrc (vidsrcme.ru), VidSrc.to, VidSrc.pm, SmashyStream, VidLink,
  // Embed.su, VidEasy, AutoEmbed, VidSrc.cc, VidSrc.wtf, VidZee, Hexa,
  // SpencerDevs, CinemaOS, PrimeSrc, Nontongo, VidFast, VidUp, SuperEmbed,
  // hls.lol and lul. Vidy (vidy.st) joined them on 2026-11-02: its
  // api.wecollege.net seed/sources API returns a Cloudflare 403 to the VPS
  // while playing from a residential IP. The relay fixes for its Next.js
  // player stay in place. The last two can be re-added via hls-player.html
  // (/hls-resolve) if that changes.
];
