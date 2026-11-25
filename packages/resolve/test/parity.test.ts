import { resolveSource } from "skills";
import { describe, expect, it } from "vite-plus/test";
import { resolvePack } from "../src/index.ts";

// Real GitHub, and `skills` itself with git: run with LOADSHEET_NET=1.
describe.skipIf(!process.env.LOADSHEET_NET)("parity with resolveSource", () => {
  it.each([
    "mattpocock/skills",
    "vercel-labs/skills",
    "https://github.com/anthropics/skills/tree/main/skills",
    "mattpocock/skills@6f7f7831a625f040a8e06a0e7954826b87ce775a",
  ])(
    "%s finds the skills that skills add finds",
    async (input) => {
      const expected = await resolveSource(input, { config: { telemetry: false } });
      await expected.dispose();
      const report = await resolvePack(input, { signal: AbortSignal.timeout(60_000) });
      const names = report.sheet
        .flatMap((sheet) => sheet.lines)
        .map((line) => line.ref.name)
        .sort();
      expect(names).toEqual(expected.skills.map((skill) => skill.name).sort());
    },
    120_000,
  );
});
