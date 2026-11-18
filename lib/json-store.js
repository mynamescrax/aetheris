import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Async disk access with atomic replacement. Callers hold their record locks
// across read-modify-write; no persistent cache can outlive a session revocation
// or an external edit. Simultaneous readers share bytes, never mutable objects.
export async function createJsonStore(dir, { io = fs } = {}) {
  await io.mkdir(dir, { recursive: true });
  const pending = new Map();
  const active = new Set();
  const journalDir = join(dir, ".transactions");
  let barrier = null;
  let failure = null;

  function pathfor(key) {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(key))
      throw new TypeError("Invalid record key");
    // The suffix is appended before joining, so even legacy dot-only usernames
    // name a file (e.g. "...json"), never a parent-directory traversal.
    return join(dir, key + ".json");
  }

  function healthy() {
    if (failure)
      throw Object.assign(
        new Error("Storage needs transaction recovery; restart the app.", {
          cause: failure,
        }),
        {
          code: "STORE_RECOVERY_REQUIRED",
          statusCode: 503,
        },
      );
  }

  function run(fn) {
    const start = () => {
      healthy();
      return fn();
    };
    let result;
    try {
      result = Promise.resolve(barrier ? barrier.then(start) : start());
    } catch (error) {
      return Promise.reject(error);
    }
    active.add(result);
    result.then(
      () => active.delete(result),
      () => active.delete(result),
    );
    return result;
  }

  async function syncDirectory(path) {
    let handle;
    try {
      handle = await io.open(path, "r");
      await handle.sync();
    } catch (error) {
      // Windows cannot open directories for fsync; some filesystems also
      // explicitly do not support it. Do not hide real disk/write failures.
      if (
        !["EINVAL", "ENOTSUP"].includes(error.code) &&
        !(
          process.platform === "win32" &&
          ["EPERM", "EISDIR", "EACCES"].includes(error.code)
        )
      )
        throw error;
    } finally {
      await handle?.close();
    }
  }

  async function replace(dest, text, durable = false) {
    const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await io.writeFile(tmp, text, {
        flag: "wx",
        mode: 0o600,
        ...(durable ? { flush: true } : {}),
      });
      await io.rename(tmp, dest);
    } catch (error) {
      if (error.code !== "EEXIST") await io.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async function removeFile(path) {
    try {
      await io.unlink(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async function apply(records, field) {
    for (const record of records) {
      const path = pathfor(record.key);
      pending.delete(record.key);
      if (record[field] === null) await removeFile(path);
      else await replace(path, record[field], true);
    }
    await syncDirectory(dir);
  }

  // Pending journals roll back; committed journals roll forward. Recovery runs
  // before account/session indexes are built. Never continue after an uncertain
  // rollback/cleanup: later writes could be overwritten by a stale journal.
  async function recover() {
    let files;
    try {
      files = await io.readdir(journalDir);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const journals = files.filter((name) =>
      /^[a-f0-9-]+\.(pending|committed)\.json$/.test(name),
    );
    if (journals.length > 1)
      throw new Error("Multiple transaction journals require manual recovery.");
    for (const name of journals) {
      const path = join(journalDir, name);
      const journal = JSON.parse(await io.readFile(path, "utf8"));
      if (
        journal.version !== 1 ||
        !Array.isArray(journal.records) ||
        !journal.records.length
      )
        throw new Error("Invalid transaction journal.");
      const keys = new Set();
      for (const record of journal.records) {
        pathfor(record.key);
        if (
          keys.has(record.key) ||
          !["string", "object"].includes(typeof record.before) ||
          (record.before !== null && typeof record.before !== "string") ||
          typeof record.after !== "string"
        )
          throw new Error("Invalid transaction record.");
        keys.add(record.key);
      }
      await apply(
        journal.records,
        name.endsWith(".committed.json") ? "after" : "before",
      );
      await removeFile(path);
      await syncDirectory(journalDir);
    }
  }
  await recover();

  const store = {
    read(key) {
      return run(async () => {
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
          if (error.code === "ENOENT") return null;
          if (error instanceof SyntaxError)
            throw Object.assign(new Error(`Invalid JSON in record ${key}.`), {
              code: "STORE_INVALID_JSON",
            });
          throw error;
        }
      });
    },

    write(key, data, { durable = false } = {}) {
      return run(async () => {
        const dest = pathfor(key);
        const text = JSON.stringify(data);
        pending.delete(key);
        try {
          await replace(dest, text, durable);
          if (durable) await syncDirectory(dir);
        } finally {
          pending.delete(key);
        }
      });
    },

    remove(key, { durable = false } = {}) {
      return run(async () => {
        const path = pathfor(key);
        pending.delete(key);
        try {
          await removeFile(path);
          if (durable) await syncDirectory(dir);
        } finally {
          pending.delete(key);
        }
      });
    },

    exists(key) {
      return run(async () => {
        try {
          await io.access(pathfor(key));
          return true;
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      });
    },

    keys() {
      return run(async () => {
        return (await io.readdir(dir, { withFileTypes: true }))
          .filter(
            (entry) =>
              (entry.isFile() || entry.isSymbolicLink()) &&
              /^[a-zA-Z0-9_.-]+\.json$/.test(entry.name),
          )
          .map((entry) => entry.name.slice(0, -5));
      });
    },

    async writeMany(entries) {
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 64)
        throw new TypeError("Expected 1–64 transaction records.");
      const keys = new Set();
      const records = entries.map(([key, value]) => {
        pathfor(key);
        if (keys.has(key)) throw new TypeError("Duplicate transaction key.");
        keys.add(key);
        const after = JSON.stringify(value);
        if (typeof after !== "string")
          throw new TypeError("Invalid transaction value.");
        return { key, after, before: null };
      });
      // Fence existing readers/writers, then keep subsequent operations behind
      // this batch. Ordinary independent operations can still run concurrently.
      const prior = [...active];
      if (barrier) prior.push(barrier);
      const operation = Promise.allSettled(prior).then(async () => {
        healthy();
        for (const record of records) {
          try {
            record.before = await io.readFile(pathfor(record.key), "utf8");
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        await io.mkdir(journalDir, { recursive: true });
        await syncDirectory(dir);
        const id = randomUUID();
        const pendingPath = join(journalDir, `${id}.pending.json`);
        const committedPath = join(journalDir, `${id}.committed.json`);
        let committed = false;
        try {
          await replace(
            pendingPath,
            JSON.stringify({ version: 1, records }),
            true,
          );
          await syncDirectory(journalDir);
          await apply(records, "after");
          await io.rename(pendingPath, committedPath);
          committed = true;
          await syncDirectory(journalDir);
          await removeFile(committedPath);
          await syncDirectory(journalDir);
        } catch (error) {
          if (committed) failure = error;
          else {
            try {
              await apply(records, "before");
              await removeFile(pendingPath);
              await syncDirectory(journalDir);
            } catch (rollbackError) {
              failure = rollbackError;
            }
          }
          throw error;
        } finally {
          for (const { key } of records) pending.delete(key);
        }
      });
      const tail = operation.catch(() => {});
      barrier = tail;
      tail.then(() => {
        if (barrier === tail) barrier = null;
      });
      return operation;
    },
  };
  return store;
}
