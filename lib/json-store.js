import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Async disk access with atomic replacement. Callers hold their record locks
// across read-modify-write; no persistent cache can outlive a session revocation
// or an external edit. Simultaneous readers share bytes, never mutable objects.
export async function createJsonStore(dir, { io = fs } = {}) {
  await io.mkdir(dir, { recursive: true });
  const pending = new Map();

  function pathfor(key) {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(key))
      throw new TypeError("Invalid record key");
    // The suffix is appended before joining, so even legacy dot-only usernames
    // name a file (e.g. "...json"), never a parent-directory traversal.
    return join(dir, key + ".json");
  }

  return {
    async read(key) {
      const path = pathfor(key);
      let request = pending.get(key);
      if (!request) {
        request = io.readFile(path, "utf8").finally(() => {
          if (pending.get(key) === request) pending.delete(key);
        });
        pending.set(key, request);
      }
      try {
        return JSON.parse(await request);
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError)
          return null;
        throw error;
      }
    },

    async write(key, data) {
      const dest = pathfor(key);
      const text = JSON.stringify(data);
      const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
      pending.delete(key);
      try {
        await io.writeFile(tmp, text, { flag: "wx", mode: 0o600 });
        await io.rename(tmp, dest);
      } catch (error) {
        // writeFile can create a partial temporary file before failing. Never
        // remove a pre-existing file if exclusive creation itself was refused.
        if (error.code !== "EEXIST") await io.unlink(tmp).catch(() => {});
        throw error;
      } finally {
        pending.delete(key);
      }
    },

    async remove(key) {
      const path = pathfor(key);
      pending.delete(key);
      try {
        await io.unlink(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      } finally {
        pending.delete(key);
      }
    },

    async exists(key) {
      try {
        await io.access(pathfor(key));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },

    async keys() {
      return (await io.readdir(dir, { withFileTypes: true }))
        .filter(
          (entry) =>
            (entry.isFile() || entry.isSymbolicLink()) &&
            /^[a-zA-Z0-9_.-]+\.json$/.test(entry.name),
        )
        .map((entry) => entry.name.slice(0, -5));
    },
  };
}
