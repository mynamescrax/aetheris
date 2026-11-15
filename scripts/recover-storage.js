// Run only while the app is stopped (deploy rollback uses this before starting
// older code, which may not understand the transaction journal format).
import { resolve } from "node:path";
import { createJsonStore } from "../lib/json-store.js";

if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/recover-storage.js <database-directory>",
  );
await createJsonStore(resolve(process.argv[2]));
