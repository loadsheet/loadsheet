import type { Report } from "@loadsheet/schema";

const num = (n: number) => n.toLocaleString("en-US");

/** The Report as a plain table per sheet, heaviest first, with a total line and the findings under it. */
export const renderText = (report: Report): string => {
  const out: string[] = [];
  const title = report.mode === "pack" ? `loadsheet: ${report.source ?? "pack"}` : "loadsheet";
  out.push(title, "");
  for (const sheet of report.sheet) {
    const lines = [...sheet.lines].sort((a, b) => b.tokens.value - a.tokens.value);
    const total = lines.reduce(
      (sum, line) => ({
        tokens: sum.tokens + line.tokens.value,
        listed: sum.listed + line.chars.listed,
        body: sum.body + line.chars.body,
      }),
      { tokens: 0, listed: 0, body: 0 },
    );
    const rows = [
      ["tokens", "listed", "body", sheet.harness],
      ...lines.map((line) => [
        num(line.tokens.value),
        num(line.chars.listed),
        num(line.chars.body),
        line.item,
      ]),
      [num(total.tokens), num(total.listed), num(total.body), `total, ${lines.length} items`],
    ];
    const widths = [0, 1, 2].map((col) => Math.max(...rows.map((row) => row[col]!.length)));
    const format = (row: string[]) =>
      [...widths.map((width, col) => row[col]!.padStart(width)), row[3]].join("  ");
    out.push(format(rows[0]!), ...rows.slice(1, -1).map(format));
    out.push(widths.map((width) => "-".repeat(width)).join("  "), format(rows.at(-1)!), "");
  }
  if (report.findings.length) {
    out.push("Findings");
    for (const finding of report.findings) {
      const saves = finding.savesTokens ? `, saves ~${num(finding.savesTokens.value)} tokens` : "";
      const fix = finding.fixes[0] ? `: ${finding.fixes[0].action} ${finding.fixes[0].path}` : "";
      out.push(
        `  ${finding.level}  ${finding.rule}  ${finding.item ?? finding.pack ?? ""}${saves}${fix}`,
      );
    }
  } else out.push("No findings.");
  if (report.skipped.length) {
    out.push(
      "",
      `Not run without usage data: ${report.skipped.map((skip) => skip.rule).join(", ")}.`,
    );
  }
  return `${out.join("\n")}\n`;
};
