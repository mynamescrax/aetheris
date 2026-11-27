// Run only while the app is stopped (deploy rollback uses this before starting
// older code, which may not understand the transaction journal format).
import { resolve } from "node:path";
import { createJsonStore } from "../lib/json-store.js";
import { lockDatabase } from "../lib/database-lock.js";

if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/recover-storage.js <database-directory>",
  );
const dir = resolve(process.argv[2]);
const release = await lockDatabase(dir);
try {
  await createJsonStore(dir);
} finally {
  await release();
}
