import { isIP } from "node:net";

// Raw handlers do not get Fastify's trustProxy processing. Only trust the last
// X-Forwarded-For hop when our direct peer is the loopback Caddy proxy.
export function rawClientIp(request) {
  const peer = request.socket?.remoteAddress || "unknown";
  const address = peer.replace(/^::ffff:/, "");
  const loopback =
    address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
  if (loopback) {
    const forwarded = request.headers["x-forwarded-for"];
    const last = String(forwarded || "")
      .split(",")
      .at(-1)
      .trim();
    if (isIP(last)) return last.replace(/^::ffff:/, "");
  }
  return address;
}
