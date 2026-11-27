/** Whether `path` starts at a root: `/`, or a drive such as `C:\`. */
export const isAbsolute = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path);

/**
 * `path` by its spelling alone: repeated `/`, `.` segments and a trailing `/` dropped, and each `..`
 * taking back the segment before it, as kit does to a source path before it keys it under home. So
 * `//home/u/./.codex/` and `/home/u/.codex` name one folder and get one Files key.
 */
export const normalPath = (path: string): string => {
  const root = /^[A-Za-z]:\//u.exec(path)?.[0] ?? (path.startsWith("/") ? "/" : "");
  const parts: string[] = [];
  for (const part of path.slice(root.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !root) parts.push(part);
  }
  const joined = parts.join("/");
  return `${root}${joined}` || ".";
};

/** An absolute path as a Files key, with the current user's home replaced by `~`. */
export const filesKey = (path: string, home: string): string => {
  const root = normalPath(home.replaceAll("\\", "/"));
  const at = normalPath(path.replaceAll("\\", "/"));
  const windows = /^[A-Za-z]:\//u.test(root);
  const key = windows ? at.toLowerCase() : at;
  const base = windows ? root.toLowerCase() : root;
  if (key === base) return "~";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return key.startsWith(prefix) ? `~/${at.slice(prefix.length)}` : at;
};

/** A usage project key, redacted before it can reach a tally or a cache. */
export const projectOfCwd = (cwd: unknown, place?: { home: string }): string => {
  if (typeof cwd !== "string" || /\p{C}/u.test(cwd)) return "unknown";
  const path = cwd.replaceAll("\\", "/");
  if (!isAbsolute(path) || (path.startsWith("//") && cwd.startsWith("\\"))) return "unknown";
  const key = place ? filesKey(path, place.home) : normalPath(path);
  return isProjectKey(key) ? key : "unknown";
};
import { isProjectKey } from "@loadsheet/schema";
