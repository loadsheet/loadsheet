import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { CANARY } from "./sanitize.ts";

function formatPath(path: readonly (string | number)[]): string {
  return (
    "$" +
    path
      .map((segment) =>
        typeof segment === "number"
          ? `[${segment}]`
          : /^[A-Za-z_$][\w$]*$/.test(segment)
            ? `.${segment}`
            : `[${JSON.stringify(segment)}]`,
      )
      .join("")
  );
}

/**
 * JSON paths (`$.a[0].b`) of every string or object key that contains the canary or one of
 * `forbidden`. A key that leaks is reported at the path of its value.
 */
export function findCanary(value: unknown, forbidden: readonly string[] = []): string[] {
  const needles = [CANARY, ...forbidden].filter((needle) => needle !== "");
  const leaks = (text: string) => needles.some((needle) => text.includes(needle));
  const found: string[] = [];
  const walk = (node: unknown, path: (string | number)[]): void => {
    if (typeof node === "string") {
      if (leaks(node)) found.push(formatPath(path));
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, index]));
    } else if (typeof node === "object" && node !== null) {
      for (const [key, item] of Object.entries(node)) {
        if (leaks(key)) found.push(formatPath([...path, key]));
        walk(item, [...path, key]);
      }
    }
  };
  walk(value, []);
  return found;
}

/**
 * Files under `dir`, relative to it, whose name or bytes contain the canary or one of
 * `forbidden`, raw or JSON-escaped. Each JSONL line is checked once more as parsed JSON, so
 * text hidden behind a `\u` escape is found too.
 */
export async function findCanaryInDir(
  dir: string,
  forbidden: readonly string[] = [],
): Promise<string[]> {
  const needles = [CANARY, ...forbidden].filter((needle) => needle !== "");
  const variants = needles.flatMap((needle) => [needle, JSON.stringify(needle).slice(1, -1)]);
  const entries = await NodeFSP.readdir(dir, { recursive: true, withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = NodePath.join(entry.parentPath, entry.name);
    const relative = NodePath.relative(dir, full);
    const text = await NodeFSP.readFile(full, "utf8");
    const parsedLeak = () =>
      text.split("\n").some((line) => {
        try {
          return findCanary(JSON.parse(line), forbidden).length > 0;
        } catch {
          return false;
        }
      });
    if (
      variants.some((needle) => relative.includes(needle) || text.includes(needle)) ||
      parsedLeak()
    ) {
      found.push(relative);
    }
  }
  return found.sort();
}
