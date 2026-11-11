import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";

function ipv6Words(value) {
  let text = value.toLowerCase();
  if (text.includes(".")) {
    const split = text.lastIndexOf(":");
    const v4 = text
      .slice(split + 1)
      .split(".")
      .map(Number);
    text =
      text.slice(0, split + 1) +
      ((v4[0] << 8) | v4[1]).toString(16) +
      ":" +
      ((v4[2] << 8) | v4[3]).toString(16);
  }
  const sides = text.split("::");
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides[1] ? sides[1].split(":") : [];
  return [
    ...left,
    ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"),
    ...right,
  ].map((v) => parseInt(v, 16));
}

export function isPublicAddress(input) {
  const address = String(input).replace(/^\[|\]$/g, "");
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 ||
          (b === 0 && (c === 0 || c === 2)) ||
          (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (net.isIPv6(address)) {
    const words = ipv6Words(address);
    if (words.slice(0, 5).every((v) => v === 0) && words[5] === 0xffff) {
      return isPublicAddress(
        [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join(
          ".",
        ),
      );
    }
    // Only global unicast; excludes loopback, unspecified, link/site local,
    // multicast, NAT64 and other non-global/translation ranges.
    return (
      (words[0] & 0xe000) === 0x2000 &&
      !(words[0] === 0x2001 && (words[1] === 0xdb8 || words[1] < 0x200)) &&
      words[0] !== 0x2002 &&
      !(words[0] === 0x3fff && words[1] <= 0x0fff)
    );
  }
  return false;
}

export async function resolvePublicUrl(raw, lookup = dns.lookup) {
  if (typeof raw !== "string" || raw.length > 8192)
    throw new Error("Invalid target URL.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid target URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Only HTTP(S) URLs without credentials are allowed.");
  if (url.port && !["80", "443"].includes(url.port))
    throw new Error("Only public web ports are allowed.");
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    throw new Error("Local hostnames are prohibited.");
  let timer;
  let addresses;
  try {
    addresses = net.isIP(host)
      ? [{ address: host, family: net.isIP(host) }]
      : await Promise.race([
          lookup(host, { all: true, verbatim: true }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("DNS lookup timed out.")),
              5000,
            );
          }),
        ]);
  } finally {
    clearTimeout(timer);
  }
  if (
    !addresses.length ||
    addresses.some((record) => !isPublicAddress(record.address))
  )
    throw new Error("Private or non-public addresses are prohibited.");
  return { url, addresses };
}

// Pin the socket to the addresses just checked. Re-resolving at connect time
// would allow a DNS rebinding target to switch to a private address.
export function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const family = typeof options === "number" ? options : options?.family;
    const selected = family
      ? addresses.filter((record) => record.family === family)
      : addresses;
    if (!selected.length)
      return callback(new Error("No validated address for this IP family."));
    if (options && options.all) return callback(null, selected);
    callback(null, selected[0].address, selected[0].family);
  };
}

export async function downloadPublicImage(
  raw,
  {
    maxBytes = 20 * 1024 * 1024,
    timeoutMs = 30000,
    headers = {},
    allowedTypes =
      /^image\/(png|jpeg|webp|gif|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/,
  } = {},
) {
  const signal = AbortSignal.timeout(timeoutMs);
  let target = raw;
  for (let hop = 0; hop <= 5; hop++) {
    const resolved = await resolvePublicUrl(target);
    const response = await new Promise((resolve, reject) => {
      const transport = resolved.url.protocol === "https:" ? https : http;
      const request = transport.get(
        resolved.url,
        { lookup: pinnedLookup(resolved.addresses), signal, headers },
        resolve,
      );
      request.on("error", reject);
    });
    if (
      response.statusCode >= 300 &&
      response.statusCode < 400 &&
      response.headers.location
    ) {
      target = new URL(response.headers.location, resolved.url).href;
      response.destroy();
      continue;
    }
    try {
      if (response.statusCode !== 200)
        throw new Error(`Image download failed (${response.statusCode}).`);
      const mime = String(response.headers["content-type"] || "")
        .split(";", 1)[0]
        .toLowerCase();
      if (!allowedTypes.test(mime))
        throw new Error("Unsupported image type: " + (mime || "unknown"));
      if (Number(response.headers["content-length"]) > maxBytes)
        throw new Error("Image exceeds the size limit.");
      let size = 0;
      const chunks = [];
      for await (const chunk of response) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("Image exceeds the size limit.");
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), mime };
    } finally {
      response.destroy();
    }
  }
  throw new Error("Too many image redirects.");
}
