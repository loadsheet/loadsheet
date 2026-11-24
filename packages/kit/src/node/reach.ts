// What removing an Item would take or break among the other Items of its machine, worked out on
// the disk. A directory entry is known by `lstat`'s device and inode, never by a path string, so
// two spellings of one place, a home behind a link, a doubled slash or letter case cannot matter.
//
// For an Item's path the walk goes from the filesystem root one component at a time, reading each
// link and walking its target the same way. `roots` are the entry at the path (the link itself
// when the last component is one) and the place it finally is; `way` is every entry visited on
// the way there; `needs` is the way plus, for a folder, every entry of its real tree, and for each
// link inside, the way to where it leads and, for a folder, that tree too. P reaches X when P's
// roots meet X's needs (X is, lies inside or leads through P), or X's roots meet P's way (P lies
// inside X, so removing it takes part of X). An Item whose needs cannot be worked out (a
// permission error, a link loop, a tree over MAX_REACH_ENTRIES, a name or link target that is not
// UTF-8, a path that is neither under the home nor absolute) gets no `reaches`, and every other
// Item lists it.
//
// What it does not see:
// - links into the folder from folders loadsheet does not read, such as a project or another
//   program;
// - harnesses loadsheet has no adapter for;
// - references by content: a hook, an MCP command or an import that points into the folder;
// - other data in the folder, such as an unpushed `.git`;
// - real `.git` and `node_modules` folders, which it skips; a link under either name is followed
//   as any other link;
// - homes shared or synced between machines;
// - hard links;
// - anything that changes between the scan and the fix;
// - what `npx skills remove` or `fleetrc remove` delete beyond the path named.
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import type { Item } from "@loadsheet/schema";

/** Entries walked per Item before its needs count as unknown. */
export const MAX_REACH_ENTRIES = 4000;

/** Links followed on one path before it counts as a loop, as Linux's `ELOOP`. */
const MAX_LINKS = 40;

/** Folders a tree walk skips, as kit's reader does. */
const SKIPPED = new Set([".git", "node_modules"]);

type Kind = "dir" | "link" | "other";
interface Entry {
  readonly id: string;
  readonly kind: Kind;
}

/** Thrown when an Item's needs cannot be worked out. */
class Unknown extends Error {}

const isMissing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const childOf = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 1));
const componentsOf = (path: string) => path.split("/").filter((part) => part && part !== ".");

/**
 * Whether Node put U+FFFD for bytes that are not UTF-8 when it read this name or link target: the
 * string then names another entry, or none. A name that holds the character itself counts too.
 */
const undecoded = (text: string) => text.includes("\uFFFD");

/** `lstat`, `readlink` and `readdir`, each asked once per path. */
const memoDisk = () => {
  const memo = <T>(read: (path: string) => T) => {
    const known = new Map<string, { value: T } | { error: unknown }>();
    return (path: string): T => {
      let result = known.get(path);
      if (!result) {
        try {
          result = { value: read(path) };
        } catch (error) {
          result = { error };
        }
        known.set(path, result);
      }
      if ("error" in result) throw result.error;
      return result.value;
    };
  };
  const lstat = memo((path): Entry | undefined => {
    try {
      const info = lstatSync(path, { bigint: true });
      const kind = info.isDirectory() ? "dir" : info.isSymbolicLink() ? "link" : "other";
      return { id: `${info.dev}:${info.ino}`, kind };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new Unknown();
    }
  });
  const readlink = memo((path) => {
    let target;
    try {
      target = readlinkSync(path);
    } catch {
      throw new Unknown();
    }
    if (undecoded(target)) throw new Unknown();
    return target;
  });
  const readdir = memo((path) => {
    let names;
    try {
      names = readdirSync(path);
    } catch {
      throw new Unknown();
    }
    if (names.some(undecoded)) throw new Unknown();
    return names;
  });
  return { lstat, readlink, readdir };
};
type Disk = ReturnType<typeof memoDisk>;

/** Where a path leads: the entry at its last component, unfollowed, and the place it ends at. */
interface Walked {
  at?: Entry;
  place?: { path: string; entry: Entry };
}

/**
 * Follows `path` from the real folder `from` (or from the root when it is absolute), adding the
 * id of every entry visited to `way`. A missing entry stops the walk with what it visited.
 */
const follow = (disk: Disk, from: string, path: string, way: Set<string>): Walked => {
  let cur = path.startsWith("/") ? "/" : from;
  let entry = disk.lstat(cur);
  if (!entry) return {};
  way.add(entry.id);
  const pending = componentsOf(path).map((name, index, all) => ({
    name,
    last: index === all.length - 1,
  }));
  const walked: Walked = {};
  let links = 0;
  while (pending.length > 0) {
    const { name, last } = pending.shift()!;
    if (entry.kind !== "dir") return walked;
    if (name === "..") {
      cur = parentOf(cur);
      const parent = disk.lstat(cur);
      if (!parent) return walked;
      entry = parent;
      way.add(entry.id);
      if (last) walked.at = entry;
      continue;
    }
    const next = childOf(cur, name);
    const found = disk.lstat(next);
    if (!found) return walked;
    way.add(found.id);
    if (last) walked.at = found;
    if (found.kind === "link") {
      links += 1;
      if (links > MAX_LINKS) throw new Unknown();
      const target = disk.readlink(next);
      if (target.startsWith("/")) {
        cur = "/";
        entry = disk.lstat("/")!;
      }
      pending.unshift(...componentsOf(target).map((part) => ({ name: part, last: false })));
      continue;
    }
    cur = next;
    entry = found;
  }
  walked.place = { path: cur, entry };
  return walked;
};

/** Adds every entry of the real folder at `dir` to `needs`, and for each link in it, where it leads. */
const walkTree = (
  disk: Disk,
  dir: string,
  entry: Entry,
  needs: Set<string>,
  walked: Set<string>,
  budget: { left: number },
) => {
  if (walked.has(entry.id)) return;
  walked.add(entry.id);
  for (const name of disk.readdir(dir)) {
    const path = childOf(dir, name);
    const found = disk.lstat(path);
    if (!found) continue;
    if (found.kind === "dir" && SKIPPED.has(name)) continue;
    budget.left -= 1;
    if (budget.left < 0) throw new Unknown();
    needs.add(found.id);
    if (found.kind === "dir") {
      walkTree(disk, path, found, needs, walked, budget);
    } else if (found.kind === "link") {
      const { place } = follow(disk, dir, name, needs);
      if (place?.entry.kind === "dir") {
        walkTree(disk, place.path, place.entry, needs, walked, budget);
      }
    }
  }
};

interface Reach {
  roots: string[];
  way: Set<string>;
  needs: Set<string>;
}

/** An Item's path on the disk: `~/...` under `home`, an absolute path as it is, else undefined. */
const onDisk = (path: string, home: string) => {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  return path.startsWith("/") ? path : undefined;
};

const reachOfPath = (disk: Disk, path: string): Reach | undefined => {
  try {
    const way = new Set<string>();
    const { at, place } = follow(disk, "/", path, way);
    const roots = [at?.id, place?.entry.id].filter((id): id is string => id !== undefined);
    const needs = new Set(way);
    if (place?.entry.kind === "dir") {
      walkTree(disk, place.path, place.entry, needs, new Set(), { left: MAX_REACH_ENTRIES });
    }
    return { roots, way, needs };
  } catch (error) {
    if (error instanceof Unknown) return undefined;
    throw error;
  }
};

const meets = (ids: readonly string[], set: Set<string>) => ids.some((id) => set.has(id));

/**
 * For each path, the other paths among `paths` that removing it reaches, sorted; undefined when
 * that is not known, as for a path that is neither `~/...` (under `home`) nor absolute.
 */
export const reachesOf = (
  paths: Iterable<string>,
  home: string,
): Map<string, string[] | undefined> => {
  const disk = memoDisk();
  const reaches = new Map<string, Reach | undefined>();
  for (const path of paths) {
    if (reaches.has(path)) continue;
    const real = onDisk(path, home);
    reaches.set(path, real === undefined ? undefined : reachOfPath(disk, real));
  }
  const result = new Map<string, string[] | undefined>();
  for (const [path, mine] of reaches) {
    if (!mine) {
      result.set(path, undefined);
      continue;
    }
    const reached: string[] = [];
    for (const [other, theirs] of reaches) {
      if (other === path) continue;
      if (!theirs || meets(mine.roots, theirs.needs) || meets(theirs.roots, mine.way)) {
        reached.push(other);
      }
    }
    result.set(path, reached.sort());
  }
  return result;
};

/** An Item with what removing it reaches, from `reachesOf`, or without `reaches` when that is not known. */
export const withReach = (item: Item, reaches: Map<string, string[] | undefined>): Item => {
  const { reaches: _old, ...rest } = item;
  const found = reaches.get(item.path);
  return found === undefined ? rest : { ...rest, reaches: found };
};
