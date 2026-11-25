import { parseReport } from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";
import example from "../../../examples/report.example.json";
import { fromShareCode, shareCode } from "../src/lib/share";

describe("a shared link", () => {
  const report = parseReport(example);
  const described = report.sheet.flatMap((s) => s.lines).filter((l) => l.description);

  it("carries no description, though the Report it came from has them", async () => {
    expect(described.length).toBeGreaterThan(0);
    const code = await shareCode(report);
    const opened = await fromShareCode(code);
    expect(opened.sheet.flatMap((s) => s.lines).filter((l) => "description" in l)).toEqual([]);
    for (const l of described) expect(code).not.toContain(l.description);
  });

  it("carries every line, with its tokens", async () => {
    const opened = await fromShareCode(await shareCode(report));
    const lines = (r: typeof report) =>
      r.sheet.flatMap((s) => s.lines.map((l) => [s.harness, l.item, l.tokens.value]));
    expect(lines(opened)).toEqual(lines(report));
  });
});
