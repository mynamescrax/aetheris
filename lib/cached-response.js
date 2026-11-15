import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip, brotliCompress, constants } from "node:zlib";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

export function contentTag(bytes) {
  return `W/"${createHash("sha256").update(bytes).digest("base64url")}"`;
}

// GET/HEAD use weak comparison, including a list of validators from a cache.
export function matchesTag(header, tag) {
  return (
    typeof header === "string" &&
    header.split(",").some((value) => {
      const candidate = value.trim();
      return (
        candidate === "*" ||
        candidate.replace(/^W\//, "") === tag.replace(/^W\//, "")
      );
    })
  );
}

// Serialize once and compress off the event loop per refresh. Every visitor
// shares the same buffers; only public, non-personalized JSON uses this helper.
export async function prepareJson(data) {
  const identity = Buffer.from(JSON.stringify(data));
  const variants = { identity };
  if (identity.length >= 1024) {
    const [gz, br] = await Promise.all([
      gzipAsync(identity),
      brotliAsync(identity, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      }),
    ]);
    if (gz.length < identity.length) variants.gzip = gz;
    if (br.length < identity.length) variants.br = br;
  }
  return { variants, etag: contentTag(identity) };
}

function selectEncoding(header, variants) {
  const weights = new Map();
  for (const part of String(header || "")
    .toLowerCase()
    .split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    const q = params.find((param) => param.trim().startsWith("q="));
    const value = q === undefined ? 1 : Number(q.trim().slice(2));
    weights.set(
      name,
      Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0,
    );
  }
  const weight = (name) =>
    weights.get(name) ??
    (name === "identity"
      ? weights.get("*") === 0
        ? 0
        : 1
      : (weights.get("*") ?? 0));
  return ["br", "gzip", "identity"]
    .filter((name) => variants[name] && weight(name) > 0)
    .sort((a, b) => weight(b) - weight(a))[0];
}

export function sendJson(req, reply, prepared, cacheControl) {
  reply
    .header("Vary", "Accept-Encoding")
    .header("Cache-Control", cacheControl)
    .header("ETag", prepared.etag)
    .header("X-Content-Type-Options", "nosniff");
  const encoding = selectEncoding(
    req.headers["accept-encoding"],
    prepared.variants,
  );
  if (!encoding) return reply.code(406).send();
  if (encoding !== "identity") reply.header("Content-Encoding", encoding);
  if (matchesTag(req.headers["if-none-match"], prepared.etag))
    return reply.code(304).send();
  return reply
    .type("application/json; charset=utf-8")
    .send(prepared.variants[encoding]);
}
