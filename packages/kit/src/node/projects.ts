// The project a session belongs to, from the cwd its transcript names. A key is a Files-style key:
// `~/…` under the home, an absolute path elsewhere, or already `owner/repo`. In order:
// 1. the git remote of the folder or its nearest ancestor below the home (`origin`, else the first
//    remote), as lowercase `owner/repo`: the last two segments of the remote's path, on any host;
// 2. the longest hint whose prefix holds the key, for folders that no longer exist;
// 3. the key itself, with a worktree folder folded to the repository it was made from.
// The home's own `.git` (a dotfiles repository) is never read, and a remote that is a path on the
// disk counts as none, so no result names an absolute path under the home.
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProjectHint } from "../index.ts";

/** The two disk reads the resolver makes, so tests can count or fake them. */
export interface ProjectFs {
  kind(path: string): "file" | "dir" | undefined;
  read(path: string): string | undefined;
}

/** Folders walked up from a cwd before giving up on finding its `.git`. */
const MAX_LEVELS = 12;

/** Git metadata files larger than this are ignored. */
const MAX_GIT_FILE_BYTES = 64 * 1024;

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
};

const isPathKey = (key: string) => key === "~" || key.startsWith("~/") || isAbsolute(key);

/** `owner/repo` from a remote URL, or undefined for a local path or a URL with fewer than two segments. */
export const repoOfRemote = (url: string): string | undefined => {
  const trimmed = url.trim();
  let path: string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)(\/.*)?$/i.exec(trimmed);
  if (scheme) {
    if (/^file:/i.test(trimmed) || !scheme[1]) return undefined;
    path = scheme[2] ?? "";
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.*)$/.exec(trimmed);
    if (!scp?.[2] || scp[2].startsWith("/")) return undefined;
    path = scp[2];
  }
  const segments = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return undefined;
  return segments.slice(-2).join("/").toLowerCase();
};

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

/** A worktree folder's key folded to the repository it was made from. */
const fold = (key: string): string => {
  const t3 = /^(~\/\.t3\/worktrees\/[^/]+)\//.exec(key);
  if (t3) return t3[1]!;
  const claude = key.indexOf("/.claude/worktrees/");
  if (claude > 0) return key.slice(0, claude);
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

  return (key) => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    let project: string;
    if (isPathKey(key)) {
      const path = toPath(key);
      const normal = toKey(path);
      project =
        repoOfDir(path, root, fs) ??
        sorted.find((hint) => holds(hint.prefix, normal))?.project ??
        fold(normal);
    } else {
      project = key.toLowerCase();
    }
    memo.set(key, project);
    return project;
  };
};

/** The organisation a project belongs to: the owner of `owner/repo`, else the first folder of its key. */
export const orgOf = (project: string): string => {
  if (project.startsWith("/")) return `/${project.split("/")[1] ?? ""}`;
  if (project === "~" || project.startsWith("~/")) {
    const first = project.split("/")[1];
    return first ? `~/${first}` : "~";
  }
  return project.split("/")[0]!;
};
