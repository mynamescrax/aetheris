import test from "node:test";
import assert from "node:assert/strict";
import { uniqueOnlineCount } from "../lib/online.js";

test("online count dedupes multiple tabs per browser", () => {
  const clients = new Set(["a1", "a2", "b1", "anon1", "anon2"]);
  const clientids = new Map([
    ["a1", "device-a"],
    ["a2", "device-a"],
    ["b1", "device-b"],
  ]);
  // device-a + device-b + two anonymous connections
  assert.equal(uniqueOnlineCount(clients, clientids), 4);

  // a reconnect (same id, new connection) must not change the count
  clients.add("a3");
  clientids.set("a3", "device-a");
  assert.equal(uniqueOnlineCount(clients, clientids), 4);

  // closing one of device-a's tabs keeps it online
  clients.delete("a2");
  clientids.delete("a2");
  assert.equal(uniqueOnlineCount(clients, clientids), 4);

  // closing the last connection removes it
  clients.delete("a1");
  clients.delete("a3");
  clientids.delete("a1");
  clientids.delete("a3");
  assert.equal(uniqueOnlineCount(clients, clientids), 3);

  assert.equal(uniqueOnlineCount(new Set(), new Map()), 0);
});
