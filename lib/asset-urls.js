// The relay serves opaque URLs, so a page never shows the CDN layout it
// pulls from: "/game-assets/m/jsdelivr/gh/user/repo@ref/file.js" is served as
// "/s/<token>/file.js" instead. The rewrite happens when the page is served,
// so the pages in the repo keep their readable paths.
import { opaqueAssetUrl } from "./game-assets.js";

// A relay URL in a document: the mirror name, then the path. The path stops
// at the first character that cannot be part of a file name.
const RELAY_URL = /\/game-assets\/m\/([a-z]+)\/([A-Za-z0-9._~!$&'()*+,;=:@%/-]*)/g;

// Rewrites every relay URL in a document to its opaque form. URLs the relay
// would not serve (an unknown mirror, a path without a directory) are left
// alone.
export function rewriteAssetUrls(text) {
  if (typeof text !== "string" || !text.includes("/game-assets/m/")) return text;
  return text.replace(RELAY_URL, (match, mirror, path) => opaqueAssetUrl(mirror, path) || match);
}
