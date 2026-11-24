/**
 * `path` by its spelling alone: repeated `/`, `.` segments and a trailing `/` dropped, and each `..`
 * taking back the segment before it, as kit does to a source path before it keys it under home. So
 * `//home/u/./.codex/` and `/home/u/.codex` name one folder and get one Files key.
 */
export const normalPath = (path: string): string => {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined || ".";
};
