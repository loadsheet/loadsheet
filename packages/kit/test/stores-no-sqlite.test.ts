import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { SqliteStore } from "../src/index.ts";
import { readStore } from "../src/node/index.ts";

// A Node without node:sqlite, as before 22.13: the import itself fails.
vi.mock("node:sqlite", () => {
  throw new Error("No such built-in module: node:sqlite");
});

let tmp: string;

beforeEach(async () => {
  tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-no-sqlite-"));
});

afterEach(async () => {
  await NodeFSP.rm(tmp, { recursive: true, force: true });
});

it("lists a database as unread when node:sqlite cannot be loaded", async () => {
  await NodeFSP.writeFile(`${tmp}/sessions.db`, "");
  const store: SqliteStore = {
    kind: "sqlite",
    name: "sessions.db",
    path: () => `${tmp}/sessions.db`,
    query: "SELECT 1 WHERE ?1",
    since: "ms",
    facts: () => [],
  };
  expect(await readStore(store, { home: tmp, env: {} }, 0)).toEqual({ unread: true });
});
