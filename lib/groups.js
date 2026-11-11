// Group chats: one JSON file per group under database/groups/, plus an
// in-memory index of the groups each account belongs to (rebuilt on startup).
// Callers serialize read-modify-write per group (withgrouplock in index.js).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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

export function createGroupStore(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const byuser = new Map(); // lowercase username -> Set of group ids
  const pathfor = (id) => join(dir, id + ".json");

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

  function read(id) {
    if (typeof id !== "string" || !GROUP_ID.test(id)) return null;
    try {
      const group = JSON.parse(readFileSync(pathfor(id), "utf8"));
      return group &&
        Array.isArray(group.members) &&
        Array.isArray(group.messages)
        ? group
        : null;
    } catch {
      return null;
    }
  }

  // write-then-rename so a crash mid-write can't leave a truncated file
  function write(group) {
    const dest = pathfor(group.id);
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(group));
    renameSync(tmp, dest);
  }

  function remove(id) {
    try {
      unlinkSync(pathfor(id));
    } catch {
      /* already gone */
    }
  }

  function newId() {
    let id;
    do id = randomBytes(9).toString("base64url");
    while (existsSync(pathfor(id)));
    return id;
  }

  function rebuild() {
    byuser.clear();
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const group = read(file.slice(0, -5));
      if (group) for (const lc of group.members) index(group.id, lc);
    }
  }

  function groupsOf(lc) {
    return [...(byuser.get(lc) || [])];
  }

  rebuild();
  return { read, write, remove, newId, index, unindex, groupsOf, rebuild };
}
