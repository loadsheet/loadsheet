// Reads the session stores that are not JSONL transcripts: a SQLite database through node:sqlite,
// or a folder of per-session JSON files. Nothing is cached: one SELECT bound to the window's start,
// or a few small files per session changed in the window, costs less than a cache would. A SQLite
// store's JSON inputs are read whole: T3 Code's 100 MB usage cache adds about 470 MB at its peak.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  FolderStore,
  Place,
  SessionStore,
  SqliteStore,
  StoreFact,
  StoreInput,
  StoreRow,
  VersionedFile,
} from "../index.ts";

/** What reading a store gave: its Facts, that it exists and could not be read, or undefined when it does not exist. */
export type StoreRead = { readonly facts: StoreFact[] } | { readonly unread: true } | undefined;

/** A session folder's file larger than this is left out, as a source file past its limit is. */
const MAX_FOLDER_FILE_BYTES = 8 * 1024 * 1024;
/** How long a query waits for a writer's lock before the database counts as unread. */
const BUSY_MS = 1000;
/** Session folders read at once. */
const FOLDER_CONCURRENCY = 16;

type Sqlite = typeof import("node:sqlite");
let sqlite: Promise<Sqlite | undefined> | undefined;

/** node:sqlite, or undefined where Node lacks it: it is unflagged from Node 22.13, and the engines allow 22.12. */
const loadSqlite = (): Promise<Sqlite | undefined> =>
  (sqlite ??= import("node:sqlite").catch(() => undefined));

const isFile = (path: string) =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

/** The file with the highest version in the folder; undefined when none matches or it cannot be listed. */
const newestFile = async ({ dir, pattern }: VersionedFile): Promise<string | undefined> => {
  const names = await readdir(dir).catch(() => []);
  let newest: { name: string; version: number } | undefined;
  for (const name of names) {
    const version = Number(pattern.exec(name)?.[1]);
    if (Number.isInteger(version) && (!newest || version > newest.version)) {
      newest = { name, version };
    }
  }
  return newest && join(dir, newest.name);
};

const pathOf = async (where: string | VersionedFile): Promise<string | undefined> =>
  typeof where === "string" ? where : newestFile(where);

/** An input's value as bound: its `read` of the parsed file, or `[]` when the file is missing or not JSON. */
const inputValue = async (
  input: StoreInput,
  place: Place,
  native: ReadonlySet<string>,
): Promise<string> => {
  const path = await pathOf(input.path(place));
  let document: unknown;
  try {
    if (!path) return "[]";
    document = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return "[]";
  }
  return JSON.stringify(input.read(document, native) ?? []);
};

/**
 * A database is opened so that no file appears beside it. One in WAL mode whose `-wal` and `-shm`
 * are there holds rows its main file does not yet: it is opened read-only and reads them through
 * those files. With no WAL, an immutable read avoids creating sidecars. With a WAL but no
 * shared-memory index, neither approach is safe: one omits data and the other can create files.
 */
const readSqlite = async (
  store: SqliteStore,
  place: Place,
  sinceMs: number,
  native: readonly string[],
): Promise<StoreRead> => {
  const path = await pathOf(store.path(place));
  if (!path || !(await isFile(path))) return undefined;
  const module = await loadSqlite();
  if (!module) return { unread: true };
  const live = await isFile(`${path}-wal`);
  if (live && !(await isFile(`${path}-shm`))) return { unread: true };
  const uri = `${pathToFileURL(path).href}?${live ? "mode=ro" : "immutable=1"}`;
  const since = store.since === "ms" ? sinceMs : new Date(sinceMs).toISOString();
  // node:sqlite refuses a parameter the query does not name, so `$native` is bound only when asked.
  const params: Record<string, string | number> = { $since: since };
  if (store.native !== undefined) params.$native = JSON.stringify(native);
  const ids = new Set(native);
  for (const input of store.inputs ?? []) params[input.param] = await inputValue(input, place, ids);
  let rows: StoreRow[];
  let db: InstanceType<Sqlite["DatabaseSync"]> | undefined;
  try {
    db = new module.DatabaseSync(uri, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
    rows = db.prepare(store.query).all(params) as StoreRow[];
  } catch {
    // Locked, corrupt, not a database, or a schema the query does not fit.
    return { unread: true };
  } finally {
    try {
      db?.close();
    } catch {}
  }
  if (!live && (await isFile(`${path}-wal`))) return { unread: true };
  return { facts: store.facts(rows, place) };
};

const readSmall = async (path: string): Promise<string | undefined> => {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_FOLDER_FILE_BYTES) return undefined;
  return readFile(path, "utf8").catch(() => undefined);
};

/** The folders `depth` levels below `root`, as paths below it; undefined when the root cannot be listed. */
const foldersBelow = async (root: string, depth: number): Promise<string[] | undefined> => {
  const top = await readdir(root, { withFileTypes: true }).catch(() => undefined);
  if (!top) return undefined;
  let folders = top.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (let level = 1; level < depth; level += 1) {
    const next: string[] = [];
    for (const folder of folders) {
      const entries = await readdir(join(root, folder), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) if (entry.isDirectory()) next.push(`${folder}/${entry.name}`);
    }
    folders = next;
  }
  return folders.sort();
};

const readFolder = async (
  store: FolderStore,
  place: Place,
  sinceMs: number,
): Promise<StoreRead> => {
  const root = store.root(place);
  const info = await stat(root).catch(() => undefined);
  if (!info?.isDirectory()) return undefined;
  const folders = await foldersBelow(root, store.depth);
  if (!folders) return { unread: true };
  const read = new Map<string, StoreFact[]>();
  const queue = folders.values();
  const worker = async () => {
    for (const folder of queue) {
      const dir = join(root, folder);
      const first = await stat(join(dir, store.files[0])).catch(() => undefined);
      if (!first?.isFile() || first.mtimeMs < sinceMs) continue;
      const files: Record<string, string | undefined> = {};
      for (const name of store.files) files[name] = await readSmall(join(dir, name));
      read.set(folder, store.facts({ folder, files }, place));
    }
  };
  await Promise.all(Array.from({ length: Math.min(FOLDER_CONCURRENCY, folders.length) }, worker));
  // In folder order, so a scan's Facts do not depend on which read finished first.
  return { facts: folders.flatMap((folder) => read.get(folder) ?? []) };
};

/**
 * Reads one store: its usage Facts since `sinceMs`, or that it could not be read. A store that is
 * not on the disk gives undefined. `native` is the ids a SQLite store with a `native` harness gets
 * as `$native`.
 */
export const readStore = (
  store: SessionStore,
  place: Place,
  sinceMs: number,
  native: readonly string[] = [],
): Promise<StoreRead> =>
  store.kind === "sqlite"
    ? readSqlite(store, place, sinceMs, native)
    : readFolder(store, place, sinceMs);
