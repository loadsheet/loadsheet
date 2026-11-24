import type { Finding, Fix, Grade, Line, Report, Sheet, Skipped } from "@loadsheet/schema";
import { SIGNALS } from "@loadsheet/schema";

/** Where the prompt a person pastes into their agent lives. */
export const PROMPT_DOC = "https://github.com/loadsheet/loadsheet/blob/main/docs/agent-prompt.md";

/** Lines shown per sheet: the heaviest, with one line for the rest. */
export const SHEET_ROWS = 10;

/** The width the text aims for; a path or a command that does not fit runs past it, never cut. */
const WIDTH = 100;

/** The widest a finding's item is padded to; a longer one pushes its evidence along. */
const ITEM_WIDTH = 32;

/**
 * Control characters and direction overrides made visible. Names, paths and commands come from
 * files on the machine, and one of them must not move the cursor or recolour the terminal.
 */
const visible = (text: string) =>
  text.replace(
    /[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Rows as columns two spaces apart; `right` columns align right, the last column is never padded.
 * A column in `caps` is padded to at most that width, and a longer cell pushes its row along.
 */
const table = (
  rows: string[][],
  right: number[] = [],
  indent = "  ",
  caps: Record<number, number> = {},
) => {
  if (!rows.length) return [];
  const widths = rows[0]!.map((_, col) =>
    Math.min(caps[col] ?? Infinity, Math.max(...rows.map((row) => row[col]?.length ?? 0))),
  );
  return rows.map((row) =>
    (
      indent +
      row
        .map((cell, col) =>
          col === row.length - 1 && !right.includes(col)
            ? cell
            : right.includes(col)
              ? cell.padStart(widths[col]!)
              : cell.padEnd(widths[col]!),
        )
        .join("  ")
    ).trimEnd(),
  );
};

/** Words after a head, wrapped at the width, each line after the first indented. */
const wrap = (head: string, words: string[], indent: string) => {
  const out: string[] = [];
  let line = head;
  for (const piece of words) {
    if (line !== head && line.length + 1 + piece.length > WIDTH) {
      out.push(line);
      line = `${indent}${piece}`;
    } else line = `${line} ${piece}`;
  }
  out.push(line);
  return out;
};

/** Names joined by commas, wrapped at the width. */
const wrapList = (head: string, names: string[], indent: string) =>
  wrap(
    head,
    names.map((name, index) => (index < names.length - 1 ? `${name},` : name)),
    indent,
  );

const tokens = (value: number) => `~${num(value)}`;

// Header

const dayCount = ([first, last]: [string, string]) =>
  Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1;

const header = (report: Report): string[] => {
  if (report.mode === "pack") {
    const harness = report.sheet[0]?.harness;
    return [
      `${report.tool}: pack ${report.source ?? ""}`.trimEnd(),
      `Weighed${harness ? ` for ${harness}` : ""} from its files alone: a pack has no sessions, so no usage.`,
    ];
  }
  const out = [
    `${report.tool}: ${report.mode} report, ${report.window[0]} to ${report.window[1]} (${plural(dayCount(report.window), "day")})`,
  ];
  const read = report.machines.filter((machine) => machine.reachable).map((m) => m.name);
  const unread = report.machines.filter((machine) => !machine.reachable);
  out.push(`${read.length === 1 ? "Machine" : "Machines"}: ${read.join(", ") || "none"}`);
  for (const machine of unread) {
    out.push(`  not read: ${machine.name}${machine.error ? ` (${machine.error})` : ""}`);
  }
  if (report.sheet.length) {
    out.push(
      ...table(
        report.sheet.map((sheet) => [
          sheet.harness,
          plural(sheet.sessions, "session"),
          sheet.fixedTokens
            ? `each starts with ${tokens(sheet.fixedTokens.value)} tokens (${sheet.fixedTokens.basis})`
            : "no token counts",
        ]),
        [1],
      ),
    );
  }
  return out;
};

// Sheets

const usesOf = (line: Line) => {
  if (line.ref.kind === "instructions") return "-";
  const uses = line.use.byModel + line.use.byUser;
  return uses ? num(uses) : "never";
};

const sheetBlock = (report: Report, sheet: Sheet): string[] => {
  const lines = [...sheet.lines].sort(
    (a, b) => b.tokens.value - a.tokens.value || compare(a.item, b.item),
  );
  const shown = lines.slice(0, SHEET_ROWS);
  const rest = lines.slice(SHEET_ROWS);
  const total = lines.reduce((sum, line) => sum + line.tokens.value, 0);
  const title =
    `${sheet.harness}: ${plural(lines.length, "line")}, ${tokens(total)} tokens listed` +
    (rest.length ? `; the ${shown.length} heaviest` : "");
  if (!lines.length) return [`${sheet.harness}: nothing installed or listed`];
  const pack = report.mode === "pack";
  const rows = pack
    ? [
        ["tokens", "listed", "body", "item"],
        ...shown.map((line) => [
          num(line.tokens.value),
          num(line.chars.listed),
          num(line.chars.body),
          line.item,
        ]),
      ]
    : [
        ["tokens", "in", "uses", "item"],
        ...shown.map((line) => [
          num(line.tokens.value),
          `${Math.round(line.exposure.share * 100)}%`,
          usesOf(line),
          line.item,
        ]),
      ];
  const out = [title, ...table(rows, [0, 1, 2])];
  if (rest.length) {
    const restTokens = rest.reduce((sum, line) => sum + line.tokens.value, 0);
    out.push(`  and ${plural(rest.length, "more line")}, ${tokens(restTokens)} tokens together`);
  }
  return out;
};

const sheetLegend = (report: Report) =>
  report.mode === "pack"
    ? "tokens: what it adds to every session; listed and body: its characters."
    : "tokens: what it adds to every session; in: share of sessions it was in; uses: times invoked.";

// Coverage

const GRADE: Record<Grade, string> = { exact: "exact", inferred: "inferred", none: "-" };

const coverageBlock = (report: Report): string[] => {
  if (!report.coverage.length) return [];
  const rows = [
    ["machine", "harness", "sessions", ...SIGNALS],
    ...report.coverage.map((entry) => [
      entry.machine,
      entry.harness,
      entry.installed ? num(entry.sessions) : "-",
      ...SIGNALS.map((signal) => GRADE[entry.signals[signal]]),
    ]),
  ];
  const absent = report.coverage.some((entry) => !entry.installed);
  return [
    `What each harness lets loadsheet see: exact, inferred, or - for nothing${absent ? "; sessions - : not installed" : ""}`,
    ...table(rows, [2]),
  ];
};

// Findings

const RULE_TITLE: Record<string, string> = {
  "invisible-skill": "listed without its description, so the model cannot tell when to use it",
  "dead-skill": "listed for weeks and never invoked",
  "manual-only": "only you invoke it, yet its description is in every session",
  "expensive-description": "its description is longer than it needs to be",
  "dead-pack": "a pack none of whose skills is used",
  duplicate: "installed more than once",
  "heavy-instructions": "an instruction file larger than it should be",
  "idle-mcp": "an MCP server listed and never called",
  "harness-mismatch": "installed for a harness you do not use",
  drift: "differs between machines",
  "short-history": "too little history to judge",
};

const LEVEL_RANK: Record<string, number> = { cut: 0, fix: 1, info: 2 };

const times = (n: number) => (n === 1 ? "once" : `${num(n)} times`);

/** The numbers a rule judged on, in a few words; unknown keys as `key value`. */
const evidenceOf = (finding: Finding): string => {
  const e = finding.evidence;
  const has = (...keys: string[]) => keys.every((key) => typeof e[key] === "number");
  const uses = (byModel = e.byModel ?? 0, byUser = e.byUser ?? 0) =>
    byModel + byUser === 0
      ? "never invoked"
      : `invoked ${times(byModel + byUser)}${byUser && !byModel ? ", by you" : ""}`;
  switch (finding.rule) {
    case "invisible-skill":
      if (has("sessions", "bare"))
        return `bare in ${num(e.bare!)} of ${plural(e.sessions!, "session")}, ${uses()}`;
      break;
    case "dead-skill":
      if (has("sessions", "days"))
        return `in ${plural(e.sessions!, "session")} over ${plural(e.days!, "day")}, never invoked`;
      break;
    case "manual-only":
      if (has("sessions", "byUser"))
        return `in ${plural(e.sessions!, "session")}, invoked by you ${times(e.byUser!)}, never by the model`;
      break;
    case "expensive-description":
      if (has("listedChars", "maxChars")) {
        const head = `${num(e.listedChars!)} characters, over ${num(e.maxChars!)}`;
        return has("sessions", "uses")
          ? `${head}; ${plural(e.uses!, "use")} in ${plural(e.sessions!, "session")}`
          : head;
      }
      break;
    case "dead-pack":
      if (has("skills", "sessions"))
        return `${plural(e.skills!, "skill")}, none invoked in ${plural(e.sessions!, "session")}`;
      break;
    case "duplicate":
      if (has("copies")) return `${num(e.copies!)} copies`;
      break;
    case "heavy-instructions":
      if (has("chars", "sessions"))
        return `${num(e.chars!)} characters, loaded in ${plural(e.sessions!, "session")}`;
      break;
    case "idle-mcp":
      if (has("sessions"))
        return `in ${plural(e.sessions!, "session")}, ${e.calls ? `called ${times(e.calls)}` : "never called"}`;
      break;
    case "harness-mismatch":
      if (has("sessions")) return `${plural(e.sessions!, "session")} in its harness`;
      break;
    case "drift":
      if (has("machines", "variants"))
        return `${num(e.variants!)} versions on ${num(e.machines!)} machines`;
      break;
    case "short-history":
      if (has("days", "sessions"))
        return `${plural(e.days!, "day")} of history, ${plural(e.sessions!, "session")}`;
      break;
  }
  return Object.entries(e)
    .map(([key, value]) => `${key} ${num(value)}`)
    .join(", ");
};

/** A fix without its machine, and the machines it is for. */
interface FixEntry {
  machines: string[];
  fix: Omit<Fix, "machine">;
  key: string;
}

/** A finding's fixes, those that differ only by machine merged into one. */
const entriesOf = (finding: Finding): FixEntry[] => {
  const entries = new Map<string, FixEntry>();
  for (const { machine, ...fix } of finding.fixes) {
    const key = JSON.stringify([fix.action, fix.path, fix.run, fix.set?.key, fix.set?.value]);
    const entry = entries.get(key) ?? { machines: [], fix, key };
    if (machine !== undefined && !entry.machines.includes(machine)) entry.machines.push(machine);
    entries.set(key, entry);
  }
  return [...entries.values()];
};

/** A fix in full, on one line when it fits, else its command or key on the next. */
const fixLines = (entry: FixEntry, showMachine: boolean, indent: string): string[] => {
  const { fix } = entry;
  const where = showMachine && entry.machines.length ? `on ${entry.machines.join(", ")}: ` : "";
  const head = `${indent}${where}${fix.action} ${fix.path}`;
  const detail = fix.run
    ? `$ ${fix.run}`
    : fix.set
      ? `${fix.set.key} = ${visible(JSON.stringify(fix.set.value))}`
      : undefined;
  if (!detail) return [head];
  const oneLine = `${head}  ${detail}`;
  return oneLine.length <= WIDTH ? [oneLine] : [head, `${indent}  ${detail}`];
};

const INSTALLER: Record<string, string> = { skills: "the skills CLI", fleetrc: "fleetrc" };

/** Why a finding has no fix, from what the Report holds about its line. */
const noFixReason = (report: Report, finding: Finding): string => {
  if (finding.level === "info") return "this is for you to know; there is nothing to change.";
  if (finding.item === undefined) return "loadsheet has no safe change to offer.";
  const harnesses = new Set(finding.where.map((where) => where.harness));
  // Its line on a harness it was found on, else on any.
  const line = [...report.sheet]
    .sort((a, b) => Number(harnesses.has(b.harness)) - Number(harnesses.has(a.harness)))
    .flatMap((sheet) => sheet.lines)
    .find((candidate) => candidate.item === finding.item);
  if (!line) return "loadsheet has no safe change to offer.";
  if (line.path === undefined)
    return "it is installed nowhere loadsheet reads, so there is no file to change.";
  if (line.managedBy === "plugin")
    return "it comes with a plugin, whose updates would undo any change to its files.";
  const installer = line.managedBy && INSTALLER[line.managedBy];
  if (installer) {
    const names = [...harnesses].join(" and ") || "this harness";
    return `${installer} manages its files, and loadsheet has no safe change to offer for ${names}.`;
  }
  return "loadsheet has no safe change to offer.";
};

const findingRows = (findings: Finding[]) =>
  table(
    findings.map((finding) => [
      finding.savesTokens ? tokens(finding.savesTokens.value) : "",
      finding.item ?? finding.pack ?? finding.where[0]?.harness ?? finding.id,
      evidenceOf(finding),
    ]),
    [0],
    "  ",
    { 1: ITEM_WIDTH },
  );

/**
 * The findings in full, rule by rule, and their summary. The summary is printed last: a terminal
 * shows the end of a long report, and it is what a person reads first.
 */
const findingsBlocks = (report: Report): { details: string[]; summary: string[] } => {
  if (!report.findings.length) return { details: [], summary: ["No findings."] };
  const showMachine = report.machines.length > 1;
  const label = (finding: Finding) => finding.item ?? finding.pack ?? finding.id;

  // A fix several findings share is printed once, with the findings it covers and every machine
  // one of them names: a finding on one machine and another on two share that machine's fix.
  const shared = new Map<string, { entry: FixEntry; covers: Finding[]; rule?: string }>();
  for (const finding of report.findings) {
    for (const entry of entriesOf(finding)) {
      const known = shared.get(entry.key) ?? { entry: { ...entry, machines: [] }, covers: [] };
      for (const machine of entry.machines)
        if (!known.entry.machines.includes(machine)) known.entry.machines.push(machine);
      known.covers.push(finding);
      shared.set(entry.key, known);
    }
  }
  for (const [key, known] of shared) if (known.covers.length < 2) shared.delete(key);

  const rules = [...new Set(report.findings.map((finding) => finding.rule))];
  const levelOf = (rule: string) =>
    Math.min(
      ...report.findings
        .filter((finding) => finding.rule === rule)
        .map((finding) => LEVEL_RANK[finding.level] ?? 3),
    );
  rules.sort((a, b) => levelOf(a) - levelOf(b));

  const groupOf = (rule: string) => report.findings.filter((finding) => finding.rule === rule);
  const summary = [
    `${plural(report.findings.length, "finding")}; the number is tokens a session would save`,
    ...table(
      rules.map((rule) => {
        const group = groupOf(rule);
        const saves = group.reduce((sum, finding) => sum + (finding.savesTokens?.value ?? 0), 0);
        const fixed = group.filter((finding) => finding.fixes.length).length;
        return [
          rule,
          num(group.length),
          saves ? tokens(saves) : "",
          fixed === group.length ? "all with a fix" : `${fixed ? num(fixed) : "none"} with a fix`,
        ];
      }),
      [1, 2],
    ),
  ];
  const out: string[] = [];
  for (const rule of rules) {
    const group = groupOf(rule);
    const fixable = group.filter((finding) => finding.fixes.length);
    const fixless = group.filter((finding) => !finding.fixes.length);
    if (out.length) out.push("");
    out.push(
      `${rule} (${group[0]!.level}), ${num(group.length)}${RULE_TITLE[rule] ? `: ${RULE_TITLE[rule]}` : ""}`,
    );
    const sharedHere: string[] = [];
    // One table per rule, so the rows of fixed and fixless findings align.
    const rows = new Map(findingRows(group).map((row, index) => [group[index]!, row]));
    for (const finding of fixable) {
      out.push(rows.get(finding)!);
      for (const entry of entriesOf(finding)) {
        const known = shared.get(entry.key);
        if (!known) {
          out.push(...fixLines(entry, showMachine, "    "));
        } else if (known.rule === undefined) {
          known.rule = rule;
          sharedHere.push(entry.key);
        } else if (known.rule !== rule) {
          out.push(`      the fix shared with ${label(known.covers[0]!)}, under ${known.rule}`);
        }
      }
    }
    for (const key of sharedHere) {
      const { entry, covers } = shared.get(key)!;
      const inGroup = covers.every((finding) => finding.rule === rule);
      const head =
        inGroup && covers.length === fixable.length
          ? [`  One fix for all ${num(covers.length)} above:`]
          : wrapList(`  One fix for ${num(covers.length)}:`, covers.map(label), "    ");
      out.push(...head, ...fixLines(entry, showMachine, "    "));
    }
    const reasons = new Map<string, Finding[]>();
    for (const finding of fixless) {
      const reason = noFixReason(report, finding);
      reasons.set(reason, [...(reasons.get(reason) ?? []), finding]);
    }
    for (const [reason, findings] of reasons) {
      const count = fixable.length || reasons.size > 1 ? ` for ${num(findings.length)}` : "";
      out.push(
        ...wrap(`  No fix${count}:`, reason.split(" "), "    "),
        ...findings.map((finding) => rows.get(finding)!),
      );
    }
  }
  return { details: out, summary };
};

// Skipped

const skippedBlock = (report: Report): string[] => {
  if (!report.skipped.length) return [];
  const why = (skip: Skipped) =>
    skip.reason === "not-enough-data"
      ? `${skip.harness}: too little data`
      : `${skip.harness}: no ${(skip.missing ?? []).join(", ") || "signal it needs"}`;
  if (report.mode === "pack" && report.skipped.every((skip) => skip.reason === "missing-signal")) {
    return wrapList(
      "Not run on a pack, which has no usage:",
      [...new Set(report.skipped.map((skip) => skip.rule))],
      "  ",
    );
  }
  const rules = [...new Set(report.skipped.map((skip) => skip.rule))];
  return [
    "Rules not run",
    ...table(
      rules.map((rule) => [
        rule,
        report.skipped
          .filter((skip) => skip.rule === rule)
          .map(why)
          .join("; "),
      ]),
    ),
  ];
};

/**
 * The Report for a person at a terminal: a header, the heaviest lines per harness, what each harness
 * lets loadsheet see, the findings by rule with every fix in full, and the rules that did not run.
 */
export const renderText = (exact: Report): string => {
  // Every string of the Report but a value to set, which is printed as JSON and escaped there.
  const report = JSON.parse(JSON.stringify(exact), (key, value: unknown) =>
    typeof value === "string" && key !== "value" ? visible(value) : value,
  ) as Report;
  const findings = findingsBlocks(report);
  const blocks = [
    header(report),
    ...report.sheet.map((sheet) => sheetBlock(report, sheet)),
    report.sheet.length ? [sheetLegend(report)] : [],
    coverageBlock(report),
    findings.details,
    skippedBlock(report),
    findings.summary,
    [
      "loadsheet changes none of your files. Every number and fix as JSON: run it again with --json",
      "To have your agent apply the fixes you accept, paste it the prompt in",
      `  ${PROMPT_DOC}`,
    ],
  ];
  return `${blocks
    .filter((block) => block.length)
    .map((block) => block.join("\n"))
    .join("\n\n")}\n`;
};
