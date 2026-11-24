// Writes schema/*.v1.json. Run after changing src/schemas.ts: pnpm --filter @loadsheet/schema generate
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jsonSchemas } from "./json-schema.ts";

const dir = fileURLToPath(new URL("../schema/", import.meta.url));
mkdirSync(dir, { recursive: true });
const files = Object.entries(jsonSchemas()).map(([name, schema]) => {
  const file = `${dir}${name}`;
  writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
  return file;
});
execFileSync("vp", ["fmt", ...files], { stdio: "inherit" });
