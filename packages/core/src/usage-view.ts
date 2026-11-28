import { orgOf } from "@loadsheet/schema";
import type { Coverage, Finding, Report, Settings, Usage } from "@loadsheet/schema";
import type { Format, Style } from "./summary.ts";
import { promptCacheDays } from "./prompt-cache.ts";
import { harnessName } from "./summary.ts";
import { visible } from "./text.ts";

/** The row every project without a repository counts under, by orgs and by projects alike. */
export const NO_REPOSITORY = "no repository";

/** Whether a usage project is a repository, `owner/repo`, rather than a folder or `unknown`. */
const isRepository = (project: string) =>
  project !== "unknown" && !project.startsWith("~") && !project.startsWith("/");

/** One row of a usage table: main sessions, how many compacted, every token and its share. */
export interface UsageRow {
  name: string;
  /** Main conversations started. */
  sessions: number;
  /** Of those, how many compacted at least once. */
  compacted: number;
  /** Input, output, cache read and cache write tokens, subagents' included. */
  tokens: number;
  /** Percent of every token, rounded so a table's shares sum to 100. */
  share: number;
}

export interface UsageTotals {
  /** Every harness, the same counters summed. */
  all: UsageRow;
  /** Subagents' conversations, counted apart from the sessions. */
  subagentSessions: number;
  /** One row per harness, by tokens. */
  harnesses: UsageRow[];
  /** One row per organisation, by tokens; every folder that is no repository in one. */
  orgs: UsageRow[];
  /** One row per repository, by tokens; every folder that is no repository in one. */
  projects: UsageRow[];
}

/** Whole percents of `values` that sum to 100, by largest remainder; all 0 when the total is. */
const shares = (values: number[]) => {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 100);
  const out = exact.map(Math.floor);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (let left = 100 - out.reduce((a, b) => a + b, 0), i = 0; left > 0; left--, i++)
    out[order[i % order.length]!.index]!++;
  return out;
};

const rowsBy = (usage: Usage, key: (cell: { harness: string; project: string }) => string) => {
  const rows = new Map<string, UsageRow>();
  const row = (name: string) => {
    let known = rows.get(name);
    if (!known) rows.set(name, (known = { name, sessions: 0, compacted: 0, tokens: 0, share: 0 }));
    return known;
  };
  for (const cell of usage.sessions) {
    if (cell.thread !== "main") continue;
    const known = row(key(cell));
    known.sessions += cell.sessions;
    known.compacted += cell.compacted;
  }
  for (const cell of usage.tokens)
    row(key(cell)).tokens +=
      cell.input + cell.output + cell.cacheRead + cell.cacheWrite + (cell.unsplit ?? 0);
  const sorted = [...rows.values()].sort(
    (a, b) =>
      b.tokens - a.tokens || b.sessions - a.sessions || (a.name < b.name ? -1 : +(a.name > b.name)),
  );
  shares(sorted.map((each) => each.tokens)).forEach((share, index) => {
    sorted[index]!.share = share;
  });
  return sorted;
};

const projectName = (project: string) => (isRepository(project) ? project : NO_REPOSITORY);

/**
 * What `loadsheet usage` counts from a Report's usage: totals, and rows by harness, organisation
 * and project. Tokens are what ccusage counts: input, output, cache reads and cache writes, plus
 * the tokens whose split is unknown.
 */
export const usageTotals = (usage: Usage | undefined): UsageTotals => {
  const cells: Usage = usage ?? { sessions: [], tokens: [] };
  const [all] = rowsBy(cells, () => "all");
  return {
    all: all ?? { name: "all", sessions: 0, compacted: 0, tokens: 0, share: 0 },
    subagentSessions: cells.sessions
      .filter((cell) => cell.thread === "subagent")
      .reduce((total, cell) => total + cell.sessions, 0),
    harnesses: rowsBy(cells, (cell) => cell.harness),
    orgs: rowsBy(cells, (cell) =>
      isRepository(cell.project) ? orgOf(cell.project) : NO_REPOSITORY,
    ),
    projects: rowsBy(cells, (cell) => projectName(cell.project)),
  };
};

// Rendering, in the default view's terminal look: 80 columns, numbers right-aligned.

export interface UsageViewOptions {
  /** Colours the output; plain text when absent. */
  style?: Style;
}

const WIDTH = 80;
/** Projects listed before the rest fold into one line. */
const TOP = 10;
/** Column ends: the name, sessions, compacted, tokens and share. */
const NAME = 30;
const SESSIONS = 40;
const COMPACTED = 54;
const TOKENS = 66;
const SHARE = 74;
/** Settings: a harness's name, then a setting's label, are padded to these widths. */
const HARNESS = 15;
const LABEL = 18;
/** Days Claude Code keeps a transcript when `cleanupPeriodDays` is unset. */
const CLAUDE_RETENTION_DAYS = 30;
const LIFETIME = { "5m": "5 minutes", "1h": "1 hour" } as const;

const plain: Style = (_format, text) => text;
const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
/** Tokens as the default view writes them, `12.3k`, and in millions and billions past those. */
export const tokens = (n: number) =>
  n < 100
    ? String(Math.round(n))
    : n < 999_950
      ? `${(n / 1000).toFixed(1)}k`
      : n < 999_950_000
        ? `${(n / 1_000_000).toFixed(1)}M`
        : `${(n / 1_000_000_000).toFixed(2)}B`;
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const fit = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, width - 1)}…`;

/** Text padded to `width` visible columns, then styled. */
const cell = (style: Style, format: Format | Format[] | undefined, text: string, width = 0) => {
  const padded = text.padEnd(width);
  if (!format) return padded;
  return style(format, text) + padded.slice(text.length);
};

/** `text` right-aligned to end at column `end` of a line already `used` columns wide. */
const at = (used: number, end: number, text: string) =>
  " ".repeat(Math.max(1, end - used - text.length)) + text;

const tableHead = (style: Style, title: string) => {
  const columns: [number, string][] = [
    [SESSIONS, "sessions"],
    [COMPACTED, "compacted"],
    [TOKENS, "tokens"],
    [SHARE, "share"],
  ];
  let line = title;
  let styled = style("bold", title);
  for (const [end, label] of columns) {
    const gap = at(line.length, end, label);
    line += gap;
    styled += style("dim", gap);
  }
  return styled;
};

const tableRow = (style: Style, row: UsageRow, format?: Format) => {
  const name = `  ${fit(visible(row.name), NAME - 3)}`;
  let line = name;
  const add = (end: number, text: string) => (line += at(line.length, end, text));
  add(SESSIONS, num(row.sessions));
  add(COMPACTED, `${num(row.compacted)} ${`${percent(row.compacted, row.sessions)}%`.padStart(4)}`);
  add(TOKENS, tokens(row.tokens));
  add(SHARE, `${row.share}%`);
  return format ? `  ${cell(style, format, name.slice(2))}${line.slice(name.length)}` : line;
};

/** The first `TOP` rows, then the rest summed into one `+ N more` row. */
const topRows = (rows: UsageRow[], noun: string): UsageRow[] => {
  // One row left over is shown as itself.
  if (rows.length <= TOP + 1) return rows;
  const rest = rows.slice(TOP);
  const more: UsageRow = { name: `+ ${plural(rest.length, `more ${noun}`)}`, ...sumRows(rest) };
  return [...rows.slice(0, TOP), more];
};

const sumRows = (rows: UsageRow[]) =>
  rows.reduce(
    (total, row) => ({
      sessions: total.sessions + row.sessions,
      compacted: total.compacted + row.compacted,
      tokens: total.tokens + row.tokens,
      share: total.share + row.share,
    }),
    { sessions: 0, compacted: 0, tokens: 0, share: 0 },
  );

/** Where a setting's value came from, as Settings names it. */
const source = (from: string | undefined) => (from && from !== "default" ? `, from ${from}` : "");

/** A setting's label and value per line, for one harness. */
const settingLines = (
  harness: string,
  settings: Settings,
  usage: Usage | undefined,
): [string, string][] => {
  if (harness === "claude-code") {
    const cache: string =
      settings.caching === "off"
        ? "off"
        : settings.cacheTtl
          ? `${LIFETIME[settings.cacheTtl]}${source(settings.cacheTtlFrom)}`
          : "Claude Code's default";
    // A cache now kept for an hour that was kept for 5 minutes earlier in the window says since when.
    const stopped =
      settings.caching === "off" ? undefined : promptCacheDays(usage, { byVia: false })[0]?.stopped;
    return [
      ["prompt cache", cache],
      ...(stopped ? [["", `5-minute writes stopped ${stopped}`] as [string, string]] : []),
      [
        "subagent cache",
        settings.subagentCacheTtl ? LIFETIME[settings.subagentCacheTtl] : "Claude Code's default",
      ],
      [
        "transcripts kept",
        settings.retentionDays === undefined
          ? `${CLAUDE_RETENTION_DAYS} days, Claude Code's default`
          : plural(settings.retentionDays, "day"),
      ],
    ];
  }
  if (harness === "codex")
    return [
      [
        "auto-compact",
        settings.autoCompactWindow === undefined
          ? "Codex's default limit"
          : `at ${tokens(settings.autoCompactWindow)} tokens`,
      ],
    ];
  return [];
};

const sameSettings = (rows: Coverage[]) =>
  rows.every((row) => JSON.stringify(row.settings) === JSON.stringify(rows[0]!.settings));

const settingsBlock = (report: Report, style: Style, used: Set<string>) => {
  const out: string[] = [];
  const harnesses = [...new Set(report.coverage.map((row) => row.harness))].filter((harness) =>
    used.has(harness),
  );
  for (const harness of harnesses) {
    const rows = report.coverage.filter((row) => row.harness === harness && row.settings);
    const each = rows.length > 1 && !sameSettings(rows) ? rows : rows.slice(0, 1);
    for (const row of each) {
      const name =
        each.length > 1 ? `${harnessName(harness)} on ${row.machine}` : harnessName(harness);
      const lines = settingLines(harness, row.settings!, report.usage);
      if (!lines.length) continue;
      // A name too long for its column goes on a line of its own.
      const own = name.length + 2 > HARNESS;
      if (own) out.push(`  ${style("bold", name)}`);
      lines.forEach(([label, value], index) => {
        const head =
          index === 0 && !own ? `  ${cell(style, "bold", name, HARNESS - 2)}` : " ".repeat(HARNESS);
        const from = value.indexOf(", from ");
        if (HARNESS + LABEL + value.length > WIDTH && from > 0) {
          out.push(`${head}${label.padEnd(LABEL)}${value.slice(0, from)}`);
          out.push(`${" ".repeat(HARNESS + LABEL)}${style("dim", value.slice(from + 2))}`);
        } else out.push(`${head}${label.padEnd(LABEL)}${value}`);
      });
    }
  }
  return out;
};

/** The usage rules whose findings this view lists, and what each asks for. */
const FIX_WORDS: Record<string, (finding: Finding) => string> = {
  "cache-ttl": (finding) =>
    finding.fixes.length
      ? "consider keeping the prompt cache 1 hour"
      : "the prompt cache lasted 5 minutes",
  "cache-off": () => "turn the prompt cache back on",
  "short-history": (finding) =>
    typeof finding.evidence.days === "number"
      ? `${plural(finding.evidence.days, "day")} of transcripts${finding.fixes.length ? "; keep them longer" : ""}`
      : "keep transcripts longer",
};

/** Unread stores that could have contributed to the selected usage. */
export const unreadUsageStores = (report: Report): string[] => {
  const { include, exclude } = report.config.via;
  const unread = report.coverage.flatMap((row) =>
    (row.unread ?? []).filter((store) => {
      const via =
        row.harness === "t3-code" && store === "statev2.sqlite"
          ? "t3-code"
          : row.harness === "opencode" && store === "opencode.db"
            ? "cli"
            : undefined;
      return !via || (!exclude.includes(via) && (!include.length || include.includes(via)));
    }),
  );
  return [...new Set(unread)].sort();
};

const fixesBlock = (report: Report, style: Style) => {
  const findings = report.findings.filter((finding) => FIX_WORDS[finding.rule]);
  if (!findings.length) return [];
  const out = ["", style("bold", "Fixes")];
  const harnesses = new Set(findings.flatMap((f) => f.where.map((where) => where.harness)));
  for (const finding of findings) {
    const where = [...new Set(finding.where.map((each) => harnessName(each.harness)))];
    const text = `${harnesses.size > 1 && where.length ? `${where.join(", ")}: ` : ""}${FIX_WORDS[finding.rule]!(finding)}`;
    const label = finding.fixes.length ? "fix" : "ask";
    out.push(`  ${cell(style, "yellow", label, 6)}  ${visible(text)}`);
    for (const fix of finding.fixes.slice(0, 2)) {
      const detail = fix.run
        ? `$ ${fix.run}`
        : fix.set
          ? `${fix.set.key} = ${JSON.stringify(fix.set.value)}`
          : "";
      out.push(`          ${style("dim", visible(`${fix.path}${detail ? `  ${detail}` : ""}`))}`);
    }
  }
  if (findings.some((finding) => finding.fixes.length)) {
    const run = `npx loadsheet --json${report.mode === "fleet" ? " --fleet" : ""}`;
    const line = `${cell(style, "dim", "Apply fixes", 15)}ask your agent to run ${style("cyan", run)}`;
    const tail = "; it gets the exact edits";
    // The explanation goes when it would push the line past the width.
    out.push(
      "",
      visible(line).length + tail.length > WIDTH ? line : `${line}${style("dim", tail)}`,
    );
  }
  return out;
};

/**
 * What a person reads after `npx loadsheet usage`: sessions, compactions and tokens over the
 * window, by harness, organisation and project, then the settings behind them and their fixes.
 */
export const renderUsage = (report: Report, options: UsageViewOptions = {}): string => {
  const style = options.style ?? plain;
  const out = [report.tool.replace("@", " ")];
  for (const machine of report.machines.filter((m) => !m.reachable))
    out.push(`not read: ${machine.name}${machine.error ? ` (${visible(machine.error)})` : ""}`);
  const read = report.machines.filter((machine) => machine.reachable).length;
  const where = read > 1 ? `on ${num(read)} machines` : "on this machine";
  const days = plural(report.config.window, "day");
  const totals = usageTotals(report.usage);
  const unread = unreadUsageStores(report);
  if (unread.length) {
    out.push("", "Usage is incomplete; these stores could not be read:");
    for (const store of unread) out.push(`  ${visible(store).slice(0, WIDTH - 2)}`);
  }
  if (!totals.all.sessions && !totals.all.tokens && !totals.subagentSessions) {
    if (unread.length) return `${out.join("\n")}\n`;
    out.push(
      "",
      `No session in the last ${days} ${where} said its project or tokens,`,
      "so there is nothing to count yet.",
    );
    return `${out.join("\n")}\n`;
  }
  out.push("", `Sessions, compactions and tokens by project, last ${days}, ${where}.`);

  out.push("", tableHead(style, "Totals"));
  for (const row of totals.harnesses)
    out.push(tableRow(style, { ...row, name: harnessName(row.name) }));
  if (totals.harnesses.length > 1) out.push(tableRow(style, totals.all, "bold"));
  if (totals.subagentSessions)
    out.push(
      `  ${style("dim", `plus ${plural(totals.subagentSessions, "subagent session")}, whose tokens are counted above`)}`,
    );

  out.push("", tableHead(style, "Orgs"));
  for (const row of topRows(totals.orgs, "org")) out.push(tableRow(style, row));

  out.push("", tableHead(style, "Projects"));
  for (const row of topRows(totals.projects, "project")) out.push(tableRow(style, row));

  const used = new Set(totals.harnesses.map((row) => row.name));
  const settings = settingsBlock(report, style, used);
  if (settings.length) out.push("", style("bold", "Settings"), ...settings);
  out.push(...fixesBlock(report, style));
  return `${out.join("\n")}\n`;
};
