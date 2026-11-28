// The project a session belongs to, from the cwd its transcript names. A key is a Files-style key:
// `~/…` under the home, an absolute path elsewhere, or already `owner/repo`. In order:
// 1. the git remote of the folder or its nearest ancestor below the home (`origin`, else the first
//    remote), as lowercase `owner/repo`: the last two segments of the remote's path, on any host;
// 2. the longest hint whose prefix holds the key, for folders that no longer exist;
// 3. for a T3 worktree that no longer exists, the remote of a live worktree of the same repository:
//    one beside it in its repository's folder, or one whose name starts with the repository's name,
//    as T3 names a worktree `<repo>-<branch>`;
// 4. the key itself, with a worktree folder folded to the repository it was made from and a
//    scratch or temporary folder folded to its parent, whose child names are often task titles. A
//    T3 worktree whose folder is gone folds to `~/.t3/worktrees`, since its name is a branch's.
// The home's own `.git` (a dotfiles repository) is never read, and a remote that is a path on the
// disk counts as none, so no result names an absolute path under the home.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProjectHint } from "../index.ts";
import { repoOfRemote } from "../project.ts";

export { repoOfRemote };
// The view of a project by its owner lives in the schema, where core and the web can reach it.
export { orgOf } from "@loadsheet/schema";

/** The disk reads the resolver makes, so tests can count or fake them. */
export interface ProjectFs {
  kind(path: string): "file" | "dir" | undefined;
  read(path: string): string | undefined;
  /** The entry names of a folder, or none when it can't be read. */
  list?(path: string): readonly string[];
}

/** Folders walked up from a cwd before giving up on finding its `.git`. */
const MAX_LEVELS = 12;

/** Git metadata files larger than this are ignored. A config with a section per branch reaches hundreds of KiB. */
const MAX_GIT_FILE_BYTES = 4 * 1024 * 1024;

/** Sibling worktrees tried when a deleted one names no repository. */
const MAX_SIBLINGS = 32;

const nodeFs: ProjectFs = {
  kind: (path) => {
    try {
      const stats = statSync(path, { throwIfNoEntry: false });
      if (stats?.isDirectory()) return "dir";
      if (stats?.isFile()) return "file";
    } catch {}
    return undefined;
  },
  read: (path) => {
    try {
      if (statSync(path).size > MAX_GIT_FILE_BYTES) return undefined;
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  list: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

const isPathKey = (key: string) => key === "~" || key.startsWith("~/") || isAbsolute(key);

/** The remote URLs of a git config, `origin` first, then the others in file order. */
const remoteUrls = (config: string): string[] => {
  const urls = new Map<string, string>();
  let remote: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]*)\]/.exec(line);
    if (section) {
      remote = /^\s*remote\s+"(.*)"\s*$/i.exec(section[1]!)?.[1];
      continue;
    }
    if (remote === undefined || urls.has(remote)) continue;
    const url = /^\s*url\s*=\s*(.*?)\s*$/i.exec(line)?.[1];
    if (url) urls.set(remote, url.replace(/^"(.*)"$/, "$1"));
  }
  const origin = urls.get("origin");
  urls.delete("origin");
  return origin === undefined ? [...urls.values()] : [origin, ...urls.values()];
};

/** The config file that holds the remotes of the repository whose `.git` is at `dotGit`. */
const configOf = (dotGit: string, fs: ProjectFs): string | undefined => {
  const kind = fs.kind(dotGit);
  if (kind === "dir") return join(dotGit, "config");
  if (kind !== "file") return undefined;
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(fs.read(dotGit) ?? "")?.[1];
  if (!gitdir) return undefined;
  const dir = resolve(dirname(dotGit), gitdir);
  const common = fs.read(join(dir, "commondir"))?.trim();
  return join(common ? resolve(dir, common) : dir, "config");
};

/** `owner/repo` of the repository holding `dir`, looking no higher than below `home`. */
const repoOfDir = (dir: string, home: string, fs: ProjectFs): string | undefined => {
  let current = dir;
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    if (current === home || current === dirname(current)) return undefined;
    const config = configOf(join(current, ".git"), fs);
    if (config) {
      const text = fs.read(config);
      if (text !== undefined) {
        for (const url of remoteUrls(text)) {
          const repo = repoOfRemote(url);
          if (repo) return repo;
        }
      }
      // The nearest repository decides: a folder inside one without a usable remote has none.
      return undefined;
    }
    current = dirname(current);
  }
  return undefined;
};

const holds = (prefix: string, key: string) =>
  key === prefix || key.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);

/** T3 Code's worktrees: `<repo>-<branch>`, or a folder named after the repository holding them. */
const T3_ROOT = "~/.t3/worktrees";
const T3_WORKTREE = /^~\/\.t3\/worktrees\/([^/]+)/;
const T3_WORKTREES = /^(~\/\.t3\/worktrees\/[^/]+)\//;

/** Folders whose children are one-off scratch or temporary folders. */
const SCRATCH = /^(~\/\.t3\/scratch|\/tmp|\/var\/tmp|\/private\/tmp)\//;

/** A worktree folder's key folded to the repository it was made from, a scratch folder to its parent. */
const fold = (key: string): string => {
  const t3 = T3_WORKTREES.exec(key);
  if (t3) return t3[1]!;
  const claude = key.indexOf("/.claude/worktrees/");
  if (claude > 0) return key.slice(0, claude);
  const scratch = SCRATCH.exec(key);
  if (scratch) return scratch[1]!;
  return key;
};

/**
 * A memoized resolver from a Files-style key to the project loadsheet groups usage by. Reads are
 * synchronous and a file that is missing or unreadable only moves on to the next source.
 */
export const createProjectResolver = ({
  home,
  hints = [],
  fs = nodeFs,
}: {
  home: string;
  hints?: readonly ProjectHint[];
  fs?: ProjectFs;
}): ((key: string) => string) => {
  const root = resolve(home);
  const toKey = (path: string) =>
    path === root ? "~" : path.startsWith(`${root}/`) ? `~/${path.slice(root.length + 1)}` : path;
  const toPath = (key: string) =>
    key === "~" ? root : key.startsWith("~/") ? join(root, key.slice(2)) : resolve(key);
  const sorted = hints
    .map((hint) => ({
      prefix: toKey(
        isAbsolute(hint.prefix) ? resolve(hint.prefix) : hint.prefix.replace(/\/+$/, ""),
      ),
      project: hint.project.toLowerCase(),
    }))
    .toSorted((a, b) => b.prefix.length - a.prefix.length);
  const memo = new Map<string, string>();
  const siblings = new Map<string, string | undefined>();
  const remotes = new Map<string, string | undefined>();
  let t3Names: readonly string[] | undefined;

  /** `owner/repo` of the repository whose checkout is `dir`, from its own `.git` only. */
  const remoteOf = (dir: string): string | undefined => {
    if (remotes.has(dir)) return remotes.get(dir);
    const config = configOf(join(dir, ".git"), fs);
    const text = config === undefined ? undefined : fs.read(config);
    const repo = text === undefined ? undefined : remoteUrls(text).map(repoOfRemote).find(Boolean);
    remotes.set(dir, repo);
    return repo;
  };

  /** The repository of a deleted worktree, read from a live worktree beside it. */
  const repoOfFolded = (folded: string, normal: string): string | undefined => {
    // A Claude Code worktree sits inside its repository, which repoOfDir already walked through.
    if (folded === normal || !T3_WORKTREES.test(normal)) return undefined;
    if (siblings.has(folded)) return siblings.get(folded);
    const dir = toPath(folded);
    let repo: string | undefined;
    for (const name of (fs.list?.(dir) ?? []).slice(0, MAX_SIBLINGS)) {
      repo = remoteOf(join(dir, name));
      if (repo) break;
    }
    siblings.set(folded, repo);
    return repo;
  };

  /**
   * The repository of a T3 worktree named `name`, from a live worktree named `<repo>` or
   * `<repo>-…` whose remote's repository is `<repo>`, the longest such prefix of `name` first.
   * When live worktrees disagree on the owner, the most of them decide, and a tie names none.
   */
  const repoOfName = (name: string): string | undefined => {
    t3Names ??= fs.list?.(toPath(T3_ROOT)) ?? [];
    const dashes = [...name.matchAll(/-/g)].map((match) => match.index);
    for (const end of [name.length, ...dashes.toReversed()]) {
      const prefix = name.slice(0, end);
      const votes = new Map<string, number>();
      const live = t3Names
        .filter((each) => each !== name && (each === prefix || each.startsWith(`${prefix}-`)))
        .slice(0, MAX_SIBLINGS);
      for (const each of live) {
        const repo = remoteOf(join(toPath(T3_ROOT), each));
        if (repo?.slice(repo.indexOf("/") + 1) === prefix.toLowerCase())
          votes.set(repo, (votes.get(repo) ?? 0) + 1);
      }
      const [first, second] = [...votes].toSorted((a, b) => b[1] - a[1]);
      if (first && first[1] !== second?.[1]) return first[0];
    }
    return undefined;
  };

  /** A T3 worktree's repository when a live worktree names it, else what the key folds to. */
  const ofT3 = (folded: string, normal: string): string | undefined => {
    const name = T3_WORKTREE.exec(normal)?.[1];
    if (name === undefined) return undefined;
    return (
      repoOfFolded(folded, normal) ??
      repoOfName(name) ??
      (fs.kind(toPath(`${T3_ROOT}/${name}`)) === "dir" ? folded : T3_ROOT)
    );
  };

  return (key) => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    let project: string;
    if (isPathKey(key)) {
      const path = toPath(key);
      const normal = toKey(path);
      const folded = fold(normal);
      project =
        repoOfDir(path, root, fs) ??
        sorted.find((hint) => holds(hint.prefix, normal))?.project ??
        ofT3(folded, normal) ??
        folded;
    } else {
      project = key.toLowerCase();
    }
    memo.set(key, project);
    return project;
  };
};
