import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Each served name under /schema/ and the `@loadsheet/schema` file it serves, at the URL its `$id` names. */
const files = {
  "v1.json": "report.v1.json",
  "scan.v1.json": "scan.v1.json",
  "config.v1.json": "config.v1.json",
};

/** Copies the JSON Schemas into `dir` under their served names. */
export function writeSchemas(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, source] of Object.entries(files))
    copyFileSync(
      fileURLToPath(new URL(`../../../packages/schema/schema/${source}`, import.meta.url)),
      join(dir, name),
    );
}
