import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Files } from "../index.ts";

/** Files larger than this many bytes are listed but read as undefined. */
export const MAX_FILE_BYTES = 1024 * 1024;

const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/**
 * A directory as Files, named after the directory. Paths are listed up front; text is read on demand.
 * Symlinks are followed; a link back into a folder being walked is skipped. Throws when the directory cannot be read.
 */
export const dirFiles = async (
  dir: string,
  { maxBytes = MAX_FILE_BYTES }: { maxBytes?: number } = {},
): Promise<Files> => {
  const root = resolve(dir);
  const paths: string[] = [];

  const walk = async (absolute: string, relative: string, ancestors: string[]): Promise<void> => {
    const real = await realpath(absolute);
    if (ancestors.includes(real)) return;
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const child = join(absolute, entry.name);
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        const target = await stat(child).catch(() => undefined);
        isDir = target?.isDirectory() ?? false;
        isFile = target?.isFile() ?? false;
      }
      if (isDir) await walk(child, path, [...ancestors, real]);
      else if (isFile) paths.push(path);
    }
  };

  if (!(await stat(root)).isDirectory()) throw new Error(`${dir} is not a directory`);
  await walk(root, "", []);
  paths.sort();
  const known = new Set(paths);

  return {
    name: basename(root),
    paths,
    text: async (path) => {
      if (!known.has(path)) return undefined;
      const absolute = join(root, path);
      if ((await stat(absolute)).size > maxBytes) return undefined;
      return readFile(absolute, "utf8");
    },
  };
};
