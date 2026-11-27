import type { Finding, Fix, Kind, Line, Report, Sheet } from "@loadsheet/schema";
import { harnessTokens, setupTokens } from "./setup.ts";
import { visible } from "./text.ts";

/** Colours and weights the summary asks for; the caller maps them to its terminal, or ignores them. */
export type Format =
  | "gray"
  | "dim"
  | "bold"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan";

/** Wraps text in formats. The summary measures text before styling, so it may add escape codes. */
export type Style = (format: Format | Format[], text: string) => string;

export interface SummaryOptions {
  /** Colours the output; plain text when absent. */
  style?: Style;
  /** Breaks this harness's context down item by item, instead of the overview of every harness. */
  harness?: string;
  /** In the breakdown, lists every skill instead of the heaviest. */
  all?: boolean;
}

const NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  grok: "Grok",
  opencode: "OpenCode",
};

/** A harness's name as people write it. */
export const harnessName = (harness: string) => NAMES[harness] ?? harness;

/** What a person types after `loadsheet` to name a harness: the part of its id before the dash. */
const shortId = (harness: string) => harness.split("-")[0]!;

/** `npx loadsheet` with arguments, as a command to copy. */
const command = (report: Report, args: string) =>
  `npx loadsheet ${args}${report.mode === "fleet" ? " --fleet" : ""}`;

/** Names as a person lists them: `A`, `A and B`, `A, B and C`. */
const listOf = (names: string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The folders each harness keeps its own files in, at home or in a project; a fix under none of
 * them, such as a pack's source, applies to every harness.
 */
const FOLDERS: Record<string, string[]> = {
  "claude-code": [".claude", ".claude.json"],
  codex: [".codex"],
  cursor: [".cursor"],
  gemini: [".gemini"],
  grok: [".grok"],
  opencode: [".opencode", "opencode"],
};

const ownerOf = (path: string) => {
  const segments = path.split("/");
  return Object.keys(FOLDERS).find((harness) =>
    FOLDERS[harness]!.some((folder) => segments.includes(folder)),
  );
};

const fixesFor = (finding: Finding, harness: string) =>
  finding.fixes.filter((fix) => {
    const owner = ownerOf(fix.path);
    return owner === undefined || owner === harness;
  });

/** The bar is this many cells; the heaviest harness's context fills LOADED of them. */
const BAR = 60;
const LOADED = 40;
/** The widest a legend line grows before it wraps. */
const WIDTH = 80;
/** Harness names are padded to this width. */
const NAME = 13;
/** The savings column ends at this column. */
const RIGHT = 72;
/** In the breakdown, token counts end at TOKENS and uses at USES. */
const TOKENS = 42;
const USES = 51;
/** Skills shown per group in the breakdown, without `--all`. */
const USED_ROWS = 5;
const NEVER_ROWS = 4;

const k = (n: number) => (n < 100 ? String(Math.round(n)) : `${(n / 1000).toFixed(1)}k`);
/** Tokens in thousands, with anything under 100 as `<0.1k`. */
const thousands = (n: number) => (n < 100 ? "<0.1k" : k(n));
const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const minus = (n: number) => `−${k(n)}`;

/** Fits text in `width` columns, cutting its middle for a path and its end for a name. */
const fit = (text: string, width: number, path = false) =>
  text.length <= width
    ? text
    : path
      ? `…${text.slice(text.length - width + 1)}`
      : `${text.slice(0, width - 1)}…`;

// What the context holds

type Part = "harness" | Kind;

const PARTS: { part: Part; label: string; format: Format }[] = [
  { part: "harness", label: "built-in", format: "gray" },
  { part: "instructions", label: "instructions", format: "green" },
  { part: "skill", label: "skills", format: "blue" },
  { part: "mcp", label: "MCP", format: "yellow" },
  { part: "subagent", label: "agents", format: "magenta" },
];

const installed = (sheet: Sheet, kind?: Kind) =>
  sheet.lines.filter((line) => line.scope !== undefined && (!kind || line.ref.kind === kind));

const sum = (lines: Line[]) => lines.reduce((total, line) => total + line.tokens.value, 0);

/** Tokens a chat of the harness starts with, part by part, and how many skills cost any. */
const partsOf = (sheet: Sheet) =>
  PARTS.map((entry) => {
    if (entry.part === "harness") return { ...entry, tokens: harnessTokens(sheet) ?? 0, note: "" };
    const lines = installed(sheet, entry.part as Kind);
    const note =
      entry.part === "skill"
        ? ` (${plural(lines.filter((line) => line.tokens.value > 0).length, "skill")})`
        : "";
    return { ...entry, tokens: sum(lines), note };
  });

const totalOf = (sheet: Sheet) => (harnessTokens(sheet) ?? 0) + setupTokens(sheet);
const windowOf = (sheet: Sheet) => sheet.contextWindow ?? 200_000;

/**
 * Cells per part: `cells` split by largest remainder, every part with tokens getting at least one.
 */
const cellsOf = (tokens: number[], cells: number) => {
  const total = tokens.reduce((a, b) => a + b, 0);
  if (!total || cells <= 0) return tokens.map(() => 0);
  const exact = tokens.map((value) => (value / total) * cells);
  const out = exact.map((value, index) =>
    tokens[index]! > 0 ? Math.max(1, Math.floor(value)) : 0,
  );
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .filter(({ index }) => tokens[index]! > 0)
    .sort((a, b) => b.rest - a.rest);
  for (let left = cells - out.reduce((a, b) => a + b, 0), i = 0; left > 0 && order.length; left--)
    out[order[i++ % order.length]!.index]!++;
  for (let over = out.reduce((a, b) => a + b, 0) - cells; over > 0; over--) {
    const widest = out.indexOf(Math.max(...out));
    out[widest]!--;
  }
  return out;
};

// What can be cut

interface Row {
  text: string;
  saves: number;
  /** Where the change goes, for the breakdown. */
  places: string[];
}

interface AskRow {
  text: string;
  saves: number;
  how?: string;
}

/** What a row is about; `brief` leaves out the window, for a row that names its source too. */
const NOUN: Record<string, (n: number, report: Report, brief?: boolean) => string> = {
  "dead-skill": (n, report, brief) =>
    `${plural(n, "skill")} never used${brief ? "" : ` in ${report.config.window} days`}`,
  "dead-pack": (n, report, brief) =>
    `${plural(n, "skill")} never used${brief ? "" : ` in ${report.config.window} days`}`,
  "expensive-description": (n, report) =>
    `${plural(n, "skill description")} over ${report.config.rules["expensive-description"].maxChars} chars`,
  "manual-only": (n) => `${plural(n, "skill")} only you invoke`,
  "idle-mcp": (n) => `${plural(n, "MCP server")} never called`,
  "heavy-instructions": (n, report) =>
    `${plural(n, "instruction file")} over ${num(report.config.rules["heavy-instructions"].maxChars)} chars`,
  duplicate: (n) => plural(n, "duplicate copy", "duplicate copies"),
  "harness-mismatch": (n) => `${plural(n, "item")} for a harness you do not use`,
  "invisible-skill": (n) => `${plural(n, "skill")} listed without a description`,
};

const VERB: Record<string, string> = {
  "dead-skill": "hide",
  "dead-pack": "hide",
  "expensive-description": "shorten",
  "manual-only": "hide",
  "idle-mcp": "turn off",
  "heavy-instructions": "trim",
  duplicate: "remove",
  "harness-mismatch": "remove",
  "invisible-skill": "make room for",
};

/** What a person calls each fix action. */
const ACTION: Record<Fix["action"], string> = {
  remove: "remove",
  "hide-from-model": "hide",
  shorten: "shorten",
  dedupe: "remove",
  set: "change",
};

/** Rules whose fix takes the whole line out of the context, so it saves the line's tokens. */
const REMOVES = new Set(["dead-skill", "dead-pack", "manual-only", "idle-mcp", "harness-mismatch"]);

/** Rules that say nothing to change. */
const SILENT = new Set(["drift", "short-history"]);

/** The lines still installed on the harness that a finding is about. */
const linesOf = (finding: Finding, sheet: Sheet) =>
  installed(sheet).filter((line) =>
    finding.item !== undefined
      ? line.item === finding.item
      : finding.pack !== undefined && line.pack === finding.pack && line.ref.kind === "skill",
  );

/** Whether a finding asks for a change to the harness's context as it is now. */
const concerns = (finding: Finding, sheet: Sheet) =>
  !SILENT.has(finding.rule) &&
  finding.level !== "info" &&
  finding.where.some((where) => where.harness === sheet.harness) &&
  (finding.item === undefined && finding.pack === undefined
    ? true
    : linesOf(finding, sheet).length > 0);

/** Items and the tokens a session of the harness would save, counting each item once. */
const tally = (findings: Finding[], sheet: Sheet) => {
  const items = new Map<string, number>();
  let other = 0;
  for (const finding of findings) {
    const lines = linesOf(finding, sheet);
    if (REMOVES.has(finding.rule) && lines.length) {
      for (const line of lines) items.set(line.item, line.tokens.value);
    } else if (finding.item !== undefined) {
      if (!items.has(finding.item)) items.set(finding.item, finding.savesTokens?.value ?? 0);
    } else {
      other += finding.savesTokens?.value ?? 0;
    }
  }
  return { count: items.size, saves: [...items.values()].reduce((a, b) => a + b, other) };
};

/** A fix's file and change with the item's name replaced by `<name>`. */
const placeOf = (fix: Fix, names: string[]) => {
  const detail = fix.run
    ? `$ ${fix.run}`
    : fix.set
      ? `${fix.set.key} = ${JSON.stringify(fix.set.value)}`
      : "";
  let text = `${fix.path}${detail ? `  ${detail}` : ""}`;
  for (const name of names) if (name) text = text.split(name).join("<name>");
  return visible(text);
};

const namesOf = (finding: Finding, sheet: Sheet) =>
  linesOf(finding, sheet)
    .flatMap((line) => [line.ref.name, line.ref.name.split(":").pop()!])
    .sort((a, b) => b.length - a.length);

const fixRows = (report: Report, sheet: Sheet): Row[] => {
  const groups = new Map<string, Finding[]>();
  for (const finding of report.findings) {
    if (!concerns(finding, sheet) || !fixesFor(finding, sheet.harness).length) continue;
    // A pack never used and a skill never used are hidden the same way, so they share a row.
    const key = finding.rule === "dead-pack" ? "dead-skill" : finding.rule;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups].map(([rule, findings]) => {
    const { count, saves } = tally(findings, sheet);
    const noun = NOUN[rule]?.(count, report) ?? `${plural(count, "item")} (${rule})`;
    const fixes = findings.flatMap((finding) =>
      fixesFor(finding, sheet.harness).map((fix) => ({ fix, finding })),
    );
    const places = new Set(fixes.map(({ fix, finding }) => placeOf(fix, namesOf(finding, sheet))));
    const actions = new Set(fixes.map(({ fix }) => fix.action));
    const action = actions.size === 1 ? [...actions][0]! : "set";
    const verb = action === "set" ? (VERB[rule] ?? "fix") : ACTION[action];
    return { text: `${verb} ${noun}`, saves, places: [...places] };
  });
};

const INSTALLER: Record<string, string> = { skills: "the skills CLI", fleetrc: "fleetrc" };

/** Findings with no fix, grouped by what installed their lines: those are the person's call. */
const askRows = (report: Report, sheet: Sheet): AskRow[] => {
  const groups = new Map<
    string,
    { rule: string; source?: string; how?: string; findings: Finding[] }
  >();
  for (const finding of report.findings) {
    if (!concerns(finding, sheet) || fixesFor(finding, sheet.harness).length) continue;
    const line = linesOf(finding, sheet)[0];
    const rule = finding.rule === "dead-pack" ? "dead-skill" : finding.rule;
    let source: string | undefined;
    let how: string | undefined;
    if (line?.managedBy === "plugin") {
      source = `${line.pack ?? "a"} plugin`;
      how = "turn it off in /plugin";
    } else if (line?.managedBy && INSTALLER[line.managedBy]) {
      source = line.pack ?? INSTALLER[line.managedBy];
      how = `change it with ${INSTALLER[line.managedBy]}`;
    }
    const key = `${rule}\0${source ?? ""}`;
    const group = groups.get(key) ?? { rule, source, how, findings: [] };
    group.findings.push(finding);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ rule, source, how, findings }) => {
    const { count, saves } = tally(findings, sheet);
    const noun = NOUN[rule]?.(count, report, true) ?? `${plural(count, "item")} (${rule})`;
    return { text: visible(source ? `${source}: ${noun}` : noun), saves, how };
  });
};

const bySaves = <T extends { saves: number }>(rows: T[]) =>
  [...rows].sort((a, b) => b.saves - a.saves);

// Rendering

const plain: Style = (_format, text) => text;

/** Text padded to `width` visible columns, then styled. */
const cell = (style: Style, format: Format | Format[] | undefined, text: string, width = 0) => {
  const padded = text.padEnd(width);
  if (!format) return padded;
  return style(format, text) + padded.slice(text.length);
};

/** The version, the machines it could not read, and what the summary teaches about `harnesses`. */
const header = (report: Report, harnesses: string[]) => {
  const out = [report.tool.replace("@", " ")];
  for (const machine of report.machines.filter((m) => !m.reachable))
    out.push(`not read: ${machine.name}${machine.error ? ` (${visible(machine.error)})` : ""}`);
  const names = harnesses.length ? listOf(harnesses.map(harnessName)) : "your coding agent";
  out.push("", `Learn what you send to ${names} with the first message of every chat.`);
  return out;
};

const harnessBlock = (style: Style, sheet: Sheet, scale: number) => {
  const parts = partsOf(sheet);
  const total = totalOf(sheet);
  const window = windowOf(sheet);
  const name = cell(style, "bold", harnessName(sheet.harness), NAME);
  const known = sheet.fixedTokens !== undefined;
  const used = Math.round((total / window) * 100);
  const remaining = Math.max(0, window - total);
  const free =
    known || remaining === 0
      ? `${Math.round((remaining / window) * 100)}% free (${k(remaining)})`
      : "free space unknown";
  const title = `${name}${k(total)} tokens · ${used}% context window${known ? "" : style("dim", "; the harness's own is unknown")}`;
  const loaded = Math.max(1, Math.round((total / scale) * LOADED));
  const cells = cellsOf(
    parts.map((part) => part.tokens),
    Math.min(loaded, BAR - 1),
  );
  const filled = cells.reduce((a, b) => a + b, 0);
  const bar =
    parts.map((part, index) => style(part.format, "█".repeat(cells[index]!))).join("") +
    style("dim", "░".repeat(BAR - filled)) +
    " " +
    style("dim", free);
  const legend: string[] = [];
  let lineText = "";
  let line = "";
  for (const part of parts) {
    if (!part.tokens) continue;
    const value = `${part.label} ${thousands(part.tokens)}${part.note}`;
    const text = `■ ${value}`;
    const styled = `${style(part.format, "■")} ${value}`;
    if (lineText && lineText.length + 2 + text.length > WIDTH) {
      legend.push(line);
      lineText = line = "";
    }
    lineText += (lineText ? "  " : "") + text;
    line += (line ? "  " : "") + styled;
  }
  if (line) legend.push(line);
  return [title, bar, ...legend];
};

/** A line of the savings table: a name column, the change, and the tokens right-aligned. */
const savingsLine = (
  style: Style,
  name: string,
  nameFormat: Format | undefined,
  text: string,
  saves: string,
) => {
  // A name as wide as the column, such as "Needs your OK", still keeps a space before the change.
  const width = Math.max(NAME, name.length + 1);
  const head = `  ${name.padEnd(width)}${text}`;
  const gap = Math.max(2, RIGHT - head.length - saves.length);
  return `  ${cell(style, nameFormat, name, width)}${text}${" ".repeat(gap)}${saves ? style(["green", "bold"], saves) : ""}`.trimEnd();
};

const overview = (report: Report, sheets: Sheet[], style: Style) => {
  const out: string[] = [];
  const scale = Math.max(...sheets.map(totalOf), 1);
  for (const sheet of sheets) out.push("", ...harnessBlock(style, sheet, scale));

  const rows = sheets.map((sheet) => ({
    sheet,
    rows: bySaves(fixRows(report, sheet)).filter((row) => row.saves > 0),
  }));
  const ask = bySaves(sheets.flatMap((sheet) => askRows(report, sheet)))[0];
  const hasEdits = report.findings.some((finding) => finding.fixes.length > 0);
  out.push("");
  if (!rows.some(({ rows }) => rows.length) && !ask) {
    out.push(
      hasEdits
        ? "Exact fixes are available, with no estimated token savings here."
        : nothingToCut(sheets),
    );
  } else {
    const title = "Breakdown";
    const unit = "saved per chat";
    out.push(
      `${style("bold", title)}${" ".repeat(Math.max(2, RIGHT - title.length - unit.length))}${style("dim", unit)}`,
    );
    for (const { sheet, rows: harnessRows } of rows) {
      harnessRows.forEach((row, index) =>
        out.push(
          savingsLine(
            style,
            index ? "" : harnessName(sheet.harness),
            undefined,
            row.text,
            row.saves ? minus(row.saves) : "",
          ),
        ),
      );
    }
    if (ask)
      out.push(
        savingsLine(style, "Needs your OK", "yellow", ask.text, ask.saves ? minus(ask.saves) : ""),
      );
  }

  out.push("");
  const commands = sheets
    .map((sheet) => style("cyan", command(report, shortId(sheet.harness))))
    .join("   ");
  out.push(`${cell(style, "dim", "More detail", NAME + 2)}${commands}`);
  out.push(
    `${cell(style, "dim", "As a web page", NAME + 2)}${style("cyan", command(report, "--ui"))}`,
  );
  if (hasEdits) out.push(applyLine(report, style));
  return out;
};

const applyLine = (report: Report, style: Style) =>
  `${cell(style, "dim", "Apply fixes", NAME + 2)}ask your agent to run ${style("cyan", command(report, "--json"))}${style("dim", "; it gets the exact edits")}`;

/** Why there is no savings table: nothing added to the harnesses yet, or nothing worth cutting. */
const nothingToCut = (sheets: Sheet[]) =>
  sheets.every((sheet) => installed(sheet).length === 0)
    ? "Skills, MCP servers and instruction files show up here once you add them."
    : "Nothing to cut: the checks found nothing unused or oversized.";

/** A row of the breakdown: a name, its tokens ending at TOKENS, then optional columns. */
const itemRow = (
  style: Style,
  name: string,
  tokens: number,
  uses?: { text: string; format?: Format },
  tag?: { text: string; format?: Format },
  path = false,
) => {
  const tokenText = k(tokens);
  const nameWidth = TOKENS - 2 - tokenText.length - 2;
  const head = `  ${fit(visible(name), nameWidth, path).padEnd(nameWidth)}  ${tokenText}`;
  let out = head;
  if (uses)
    out +=
      " ".repeat(Math.max(1, USES - head.length - uses.text.length)) +
      cell(style, uses.format, uses.text);
  if (tag) out += `   ${cell(style, tag.format, tag.text)}`;
  return out;
};

const sectionHead = (style: Style, title: string, tokens: number, column?: string) => {
  const tokenText = k(tokens);
  const head = `${title}${" ".repeat(Math.max(2, TOKENS - title.length - tokenText.length))}${tokenText}`;
  const styled = `${style("bold", title)}${head.slice(title.length)}`;
  return column
    ? `${styled}${" ".repeat(Math.max(1, USES - head.length - column.length))}${style("dim", column)}`
    : styled;
};

const usesOf = (line: Line) => line.use.byModel + line.use.byUser;
const heaviest = (a: Line, b: Line) =>
  b.tokens.value - a.tokens.value || (a.item < b.item ? -1 : 1);

const breakdown = (report: Report, sheet: Sheet, style: Style, all: boolean) => {
  const out = ["", ...harnessBlock(style, sheet, totalOf(sheet))];
  const harness = harnessTokens(sheet);
  out.push("", sectionHead(style, "built-in", harness ?? 0));
  out.push(
    `  ${style("dim", harness === undefined ? "no chat reported what it started with" : `system prompt and built-in tools, set by ${harnessName(sheet.harness)}`)}`,
  );

  const hidden = new Set(
    report.findings
      .filter(
        (finding) =>
          (finding.rule === "dead-skill" || finding.rule === "dead-pack") &&
          finding.where.some((where) => where.harness === sheet.harness) &&
          fixesFor(finding, sheet.harness).length,
      )
      .flatMap((finding) => linesOf(finding, sheet).map((line) => line.item)),
  );
  const never = { text: "never", format: "red" as Format };

  const instructions = installed(sheet, "instructions").sort(heaviest);
  if (instructions.length) {
    out.push(
      "",
      sectionHead(
        style,
        `instructions · ${plural(instructions.length, "file")}`,
        sum(instructions),
      ),
    );
    for (const line of instructions)
      out.push(
        itemRow(style, line.path ?? line.ref.name, line.tokens.value, undefined, undefined, true),
      );
  }

  const skills = installed(sheet, "skill").sort(heaviest);
  if (skills.length) {
    out.push("", sectionHead(style, `skills · ${num(skills.length)} listed`, sum(skills), "uses"));
    const used = skills.filter((line) => usesOf(line) > 0);
    const unused = skills.filter((line) => usesOf(line) === 0);
    const usedShown = all ? used : used.slice(0, USED_ROWS);
    const unusedShown = all ? unused : unused.slice(0, NEVER_ROWS);
    if (usedShown.length) {
      out.push(`  ${style("dim", "used, heaviest first")}`);
      for (const line of usedShown)
        out.push(itemRow(style, line.ref.name, line.tokens.value, { text: num(usesOf(line)) }));
    }
    if (unusedShown.length) {
      if (usedShown.length) out.push("");
      out.push(`  ${style("dim", `never used in ${report.config.window} days, heaviest first`)}`);
      for (const line of unusedShown)
        out.push(
          itemRow(
            style,
            line.ref.name,
            line.tokens.value,
            never,
            hidden.has(line.item) ? { text: "hide", format: "red" } : undefined,
          ),
        );
    }
    const moreUsed = used.length - usedShown.length;
    const moreNever = unused.length - unusedShown.length;
    if (moreUsed + moreNever) {
      const text = `+ ${num(moreUsed + moreNever)} more: ${num(moreUsed)} used, ${num(moreNever)} never used`;
      out.push(`  ${text}   ${style("cyan", command(report, `${shortId(sheet.harness)} --all`))}`);
    }
  }

  const mcp = installed(sheet, "mcp").sort(heaviest);
  if (mcp.length) {
    out.push("", sectionHead(style, `MCP · ${plural(mcp.length, "server")}`, sum(mcp), "calls"));
    for (const line of mcp)
      out.push(
        itemRow(
          style,
          line.ref.name,
          line.tokens.value,
          usesOf(line) ? { text: num(usesOf(line)) } : never,
        ),
      );
  }

  const agents = installed(sheet, "subagent").sort(heaviest);
  if (agents.length) {
    out.push("", sectionHead(style, `agents · ${num(agents.length)}`, sum(agents), "uses"));
    for (const line of agents)
      out.push(
        itemRow(
          style,
          line.ref.name,
          line.tokens.value,
          usesOf(line) ? { text: num(usesOf(line)) } : never,
        ),
      );
  }

  const rows = bySaves(fixRows(report, sheet));
  const asks = bySaves(askRows(report, sheet));
  out.push("");
  if (!rows.length && !asks.length) {
    out.push(nothingToCut([sheet]));
  } else {
    out.push(style("bold", "Fixes"));
    for (const row of rows) {
      const saves = row.saves
        ? style(["green", "bold"], minus(row.saves).padStart(6))
        : cell(style, "yellow", "fix", 6);
      out.push(`  ${saves}  ${row.text}`);
      for (const place of row.places.slice(0, 2)) out.push(`          ${style("dim", place)}`);
      if (row.places.length > 2)
        out.push(`          ${style("dim", `and ${plural(row.places.length - 2, "more place")}`)}`);
    }
    for (const ask of asks) {
      const saves = ask.saves ? ` (${style("green", minus(ask.saves))})` : "";
      out.push(
        `  ${style("yellow", "ask".padEnd(6))}  ${ask.text}${saves}${ask.how ? `; ${ask.how}` : ""}`,
      );
    }
  }
  if (rows.length) out.push("", applyLine(report, style));
  return out;
};

/** Said when no harness had a chat, on two lines that fit a terminal. */
const nothingYet = (report: Report) => {
  const where = report.machines.length > 1 ? "on these machines" : "on this machine";
  return [
    `No Claude Code or Codex chats were found ${where} in the last ${plural(report.config.window, "day")},`,
    "so there is nothing to measure yet.",
  ];
};

/**
 * What a person reads after `npx loadsheet`: how much of each harness's context a chat starts
 * with, and what they can get back. With `harness`, that harness item by item.
 */
export const renderSummary = (report: Report, options: SummaryOptions = {}): string => {
  const style = options.style ?? plain;
  if (options.harness !== undefined) {
    const out = header(report, [options.harness]);
    const sheet = report.sheet.find((candidate) => candidate.harness === options.harness);
    if (!sheet || !sheet.sessions) {
      out.push(
        "",
        `${harnessName(options.harness)} had no chats in the last ${plural(report.config.window, "day")}, so there is nothing to break down.`,
      );
    } else {
      out.push(...breakdown(report, sheet, style, options.all ?? false));
    }
    return `${out.join("\n")}\n`;
  }
  const sheets = report.sheet.filter((sheet) => sheet.sessions > 0);
  const out = header(
    report,
    sheets.map((sheet) => sheet.harness),
  );
  if (!sheets.length) out.push("", ...nothingYet(report));
  else out.push(...overview(report, sheets, style));
  return `${out.join("\n")}\n`;
};
