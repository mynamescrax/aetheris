// Existing TMDB and provider configuration; no provider URLs changed.
var TMDB_KEY = "2713804610e1e236b1cf44bfac3a7776";
var TMDB_IMG = "https://image.tmdb.org/t/p/w342";
var TMDB_API = "https://api.themoviedb.org/3";

var MOVIES_SOURCES = [
  {
    // Cloudflare-challenges non-browser clients on its media CDN
    // (see CLAUDE.md findings), so this source loads direct: the
    // real browser passes the challenge itself. Trade-off: ads
    // run and the provider sees the visitor IP (uBlock helps).
    name: "VidSrc (vidsrcme.ru) • direct",
    direct: true,
    url: function (t, id, s, e) {
      return (
        "https://vidsrcme.ru/embed/" +
        (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e)
      );
    },
  },
  {
    name: "2Embed (2embed.cc)",
    url: function (t, id, s, e) {
      // 2Embed's TV endpoint expects its parameters after a
      // literal ampersand. With a normal `?s=...`, it silently
      // ignores the selection and always serves S1 E1.
      var upstream =
        t === "movie"
          ? "https://www.2embed.cc/embed/" + id
          : "https://www.2embed.cc/embedtv/" + id + "&s=" + s + "&e=" + e;
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  {
    name: "SmashyStream",
    url: function (t, id, s, e) {
      var upstream =
        "https://embed.smashystream.com/playere.php?tmdb=" +
        id +
        (t === "tv" ? "&season=" + s + "&episode=" + e : "");
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  {
    name: "VidSrc.to (vidsrc.to)",
    url: function (t, id, s, e) {
      var upstream =
        "https://vidsrc.to/embed/" +
        (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e);
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
];
