import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { validatorModules } from "../scripts/validators.ts";

test("the committed validators match what the installed ajv compiles", () => {
  for (const [name, code] of Object.entries(validatorModules()))
    expect(
      readFileSync(new URL(`../src/generated/${name}`, import.meta.url), "utf8"),
      `src/generated/${name} is stale; run \`pnpm --filter @loadsheet/mcp generate\``,
    ).toBe(code);
});
