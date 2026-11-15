// Group chats: one JSON file per group under database/groups/, plus an
// in-memory index of the groups each account belongs to (rebuilt on startup).
// Callers serialize read-modify-write per group (withgrouplock in index.js).
import { randomBytes } from "node:crypto";
import { createJsonStore } from "./json-store.js";

export const GROUP_ID = /^[A-Za-z0-9_-]{12}$/;
export const GROUP_MAX_MEMBERS = 20;
export const GROUP_MAX_PER_USER = 50;
export const GROUP_MSG_MAX = 1000;
export const GROUP_NAME_MAX = 40;

export function cleanGroupName(value) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, GROUP_NAME_MAX)
    : "";
}

export async function createGroupStore(dir) {
  const records = await createJsonStore(dir);
  const byuser = new Map(); // lowercase username -> Set of group ids

  function index(id, lc) {
    let ids = byuser.get(lc);
    if (!ids) byuser.set(lc, (ids = new Set()));
    ids.add(id);
  }

  function unindex(id, lc) {
    const ids = byuser.get(lc);
    if (!ids) return;
    ids.delete(id);
    if (!ids.size) byuser.delete(lc);
  }

  async function read(id) {
    if (typeof id !== "string" || !GROUP_ID.test(id)) return null;
    const group = await records.read(id);
    return group &&
      Array.isArray(group.members) &&
      Array.isArray(group.messages)
      ? group
      : null;
  }

  // write-then-rename so a crash mid-write can't leave a truncated file
  function write(group) {
    return records.write(group.id, group);
  }

  function remove(id) {
    return records.remove(id);
  }

  async function newId() {
    let id;
    do id = randomBytes(9).toString("base64url");
    while (await records.exists(id));
    return id;
  }

  async function rebuild() {
    byuser.clear();
    for (const id of await records.keys()) {
      const group = await read(id);
      if (group) for (const lc of group.members) index(group.id, lc);
    }
  }

  function groupsOf(lc) {
    return [...(byuser.get(lc) || [])];
  }

  await rebuild();
  return { read, write, remove, newId, index, unindex, groupsOf, rebuild };
}
