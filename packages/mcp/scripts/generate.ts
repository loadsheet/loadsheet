// Writes src/generated/*.js, the meta-schema validators compiled ahead of time. Workers forbid
// `new Function`, which Ajv compiles with at runtime. Run after updating ajv:
// pnpm --filter @loadsheet/mcp generate
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validatorModules } from "./validators.ts";

const dir = fileURLToPath(new URL("../src/generated/", import.meta.url));
for (const [name, code] of Object.entries(validatorModules())) writeFileSync(`${dir}${name}`, code);
