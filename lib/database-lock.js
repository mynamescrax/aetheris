import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

// Hold one kernel-owned IPC address per local database directory, independent
// of the HTTP/worker ports. Linux abstract sockets and Windows named pipes go
// away even after a hard kill. Never unlink another process's socket on bind.
export async function lockDatabase(dir) {
  await mkdir(dir, { recursive: true });
  const path = await realpath(dir);
  const windows = process.platform === "win32";
  const hash = createHash("sha256").update(windows ? path.toLowerCase() : path).digest("hex");
  const name = "aetheris-db-" + hash;
  const address = windows ? "\\\\.\\pipe\\" + name : process.platform === "linux"
    ? "\0" + name : join(path, ".writer.sock");
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, resolve);
  }).catch(cause => {
    throw new Error(`Cannot acquire exclusive database lock for ${path}: ${cause.code}. Stop any other writer before starting recovery.`, { cause });
  });
  server.unref();
  return () => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}
