import { parseReport, type Finding, type Line, type Report, type Sheet } from "@loadsheet/schema";
import example from "../../../../examples/report.example.json";
import packExample from "../../../../examples/report.pack.example.json";
import { shareCode } from "./share";
import mattpocock from "../data/pack.mattpocock-skills.json";
import pstack from "../data/pack.pstack.json";

export type { Finding, Line, Report, Sheet };

/** The example the landing page draws, whatever report is open. */
export const exampleReport = parseReport(example);
export interface Pack {
  report: Report;
  title: string;
  by?: string;
}
/**
  Packs this page can show without a server. The two named ones were read from the repositories' own
  plugin manifests and SKILL.md files (names, descriptions and sizes), the way the pack checker will.
*/
export const bundledPacks: Readonly<Record<string, Pack>> = {
  "mattpocock/skills": {
    report: parseReport(mattpocock),
    title: "Matt Pocock's skills",
    by: "Matt Pocock",
  },
  "cursor/plugins/pstack": { report: parseReport(pstack), title: "pstack", by: "Lauren Tan" },
  "northwind-ai/agent-skills": { report: parseReport(packExample), title: "agent-skills" },
};
/** Why a server couldn't read a pack: the `code` of its answer, such as `not-found`, and its message. */
export interface PackError {
  code: string;
  message: string;
}
/** `github.com/owner/repo`, `owner/repo` or `github.com/owner/repo/tree/main/dir` → `owner/repo[/dir]`. */
export function packSlug(input: string): string | undefined {
  const m = input
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .match(/^([\w.-]+)\/([\w.-]+)(?:\/tree\/[^/]+((?:\/[\w.-]+)+))?/);
  return m ? `${m[1]}/${m[2]!.replace(/\.git$/, "")}${m[3] ?? ""}` : undefined;
}
/** The pack page for `owner/repo[/dir]`, by route name, one `slug` segment per folder. */
export const packRoute = (slug: string) => ({ name: "pack", params: { slug: slug.split("/") } });
/** Tokens a pack adds to every session once installed: what the model is shown before it uses anything. */
export const packTokens = (r: Report) => r.sheet[0]!.lines.reduce((n, l) => n + l.tokens.value, 0);

/**
  How a share link addresses the page: `hash` for a page with a hash router (`<base>#/report?h=…&r=…`), `path` for
  loadsheet.dev's own routes (`<base>report?h=…#r=…`). Either way the report rides in the fragment.
*/
export type ShareForm = "hash" | "path";
/** A link that opens `r` at `path` (and harness `h`) on the page at `base`; the report rides in the fragment, without its descriptions. */
export async function shareLink(
  r: Report,
  base: string,
  path = "/report",
  h?: string,
  form: ShareForm = "hash",
) {
  const code = await shareCode(r);
  const harness = h ? `h=${encodeURIComponent(h)}` : "";
  return form === "path"
    ? `${base.replace(/\/+$/, "")}${path}${harness ? `?${harness}` : ""}#r=${code}`
    : `${base}#${path}?${harness ? `${harness}&` : ""}r=${code}`;
}

// ─── words ───

const HARNESS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  gemini: "Gemini CLI",
};
export const harnessName = (h: string) => HARNESS[h] ?? h;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const day = (d: string) => {
  const [, m, dd] = d.split("-");
  return `${Number(dd)} ${MON[Number(m) - 1]}`;
};
export const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
export const K = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(Math.round(n));
export const pct = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${fmt(n)} ${n === 1 ? one : many}`;

export const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${fmt(n)} times`);
const list = (xs: string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? "");

export const uses = (l: Line) => l.use.byModel + l.use.byUser;
export const isUsed = (l: Line) => uses(l) > 0;
/** What a line adds to the average session: its tokens times the share of sessions it was in. */
export const perSession = (l: Line) => l.tokens.value * l.exposure.share;
export const itemName = (id: string) => id.replace(/^(skill|mcp|subagent|instructions):/, "");
export const findingName = (f: Finding) =>
  f.item ? itemName(f.item) : (f.pack ?? (f.where[0] ? harnessName(f.where[0].harness) : f.rule));
/** A plugin skill is named `pack:skill`; inside its pack the prefix is noise. */
export const shortName = (l: Line) =>
  l.pack && l.ref.name.startsWith(`${l.pack.split("/").pop()}:`)
    ? l.ref.name.slice(l.ref.name.indexOf(":") + 1)
    : l.ref.name;

// ─── kinds: each loaded thing is a block in the colour of its kind ───

export type Kind = "mcp" | "instr" | "skill" | "agent";
/** In the order the map, the legend and the filters show them. */
export const KINDS: { id: Kind; one: string; many: string }[] = [
  { id: "mcp", one: "MCP server", many: "MCP servers" },
  { id: "instr", one: "Instruction file", many: "Instruction files" },
  { id: "skill", one: "Skill", many: "Skills" },
  { id: "agent", one: "Subagent", many: "Subagents" },
];
const KIND_OF = { mcp: "mcp", instructions: "instr", skill: "skill", subagent: "agent" } as const;
export const kindOf = (l: Line): Kind => KIND_OF[l.ref.kind];
export const kindName = (k: Kind) => KINDS.find((x) => x.id === k)!.one;
/**
  Loaded in at least one session and used in none. Instruction files are read, not called, so they never count;
  a pack's lines have no sessions, so nothing in a pack does either.
*/
export const isDead = (l: Line) =>
  l.ref.kind !== "instructions" && l.exposure.sessions > 0 && !isUsed(l);
/** A line's size on the map: the tokens it adds to the average session, or its tokens when there is no history. */
export const costOn = (sheet: Sheet) => (l: Line) =>
  sheet.sessions > 0 ? perSession(l) : l.tokens.value;

export interface Totals {
  /** Every kind with at least one line, with its count and tokens. */
  kinds: { id: Kind; many: string; count: number; tokens: number }[];
  dead: { count: number; tokens: number };
  /** Tokens your setup adds; `total` adds the harness's own, when the report measured it. */
  setup: number;
  harness: number;
  total: number;
}
export function totals(sheet: Sheet): Totals {
  const cost = costOn(sheet);
  const kinds = KINDS.map((k) => {
    const ls = sheet.lines.filter((l) => kindOf(l) === k.id);
    return { ...k, count: ls.length, tokens: ls.reduce((n, l) => n + cost(l), 0) };
  }).filter((k) => k.count);
  const dead = sheet.lines.filter(isDead);
  const setup = kinds.reduce((n, k) => n + k.tokens, 0);
  const total = Math.max(setup, sheet.fixedTokens?.value ?? setup);
  return {
    kinds,
    dead: { count: dead.length, tokens: dead.reduce((n, l) => n + cost(l), 0) },
    setup,
    harness: total - setup,
    total,
  };
}

// ─── findings, in words ───

export const RULE: Record<string, string> = {
  "invisible-skill": "Invisible to the model",
  "dead-skill": "Never used",
  "manual-only": "Only you call it",
  "expensive-description": "Long description",
  "dead-pack": "Unused pack",
  duplicate: "Installed twice",
  "heavy-instructions": "Long instructions",
  "idle-mcp": "MCP never called",
  "harness-mismatch": "Unused harness",
  drift: "Differs between machines",
  "short-history": "Short history",
};
/** A rule a newer loadsheet added still reads as words. */
export const ruleName = (rule: string) =>
  RULE[rule] ?? rule.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
const limit = (r: Report, rule: "heavy-instructions" | "expensive-description") =>
  fmt(r.config.rules[rule].maxChars);
const machinesOf = (f: Finding) => list([...new Set(f.where.map((w) => w.machine))]);

/** The one-line reason under a fix, against the limits in `r`'s config. */
export function evidence(f: Finding, r: Report): string {
  const e = f.evidence;
  const n = (k: string) => fmt(e[k] ?? 0);
  switch (f.rule) {
    case "idle-mcp":
      return `Loaded in ${n("sessions")} sessions. The model never called it.`;
    case "dead-pack":
      return `Listed in ${n("sessions")} sessions. None of its ${n("skills")} skills was used.`;
    case "dead-skill":
      return `Listed in ${n("sessions")} sessions. Never used, by the model or by you.`;
    case "heavy-instructions":
      return `${n("chars")} characters, read in ${n("sessions")} sessions.`;
    case "expensive-description":
      return `Its description is ${n("listedChars")} characters and every session reads it. Aim for ${limit(r, "expensive-description")}.`;
    case "manual-only":
      return `You called it ${times(e.byUser ?? 0)}. The model never picked it up.`;
    case "invisible-skill":
      return `Listed without its description in ${n("bare")} of ${n("sessions")} sessions, so the model can't tell when to use it.`;
    case "drift":
      return `${machinesOf(f)} have different copies of it.`;
    case "duplicate":
      return `${n("copies")} copies installed, and every session lists each one.`;
    case "harness-mismatch":
      return "Installed for a harness with no sessions.";
    case "short-history":
      return `Only ${n("days")} days and ${n("sessions")} sessions so far, so checks that need a month wait.`;
    default:
      return Object.entries(e)
        .map(([k, v]) => `${k} ${fmt(v)}`)
        .join(" · ");
  }
}

/**
  How a fix reads: the exact command, the setting to add to a file, or, when neither exists, the change in words for
  an agent to make.
*/
export type FixView =
  | { type: "cmd"; text: string }
  | { type: "set"; text: string; file: string }
  | { type: "ask"; text: string };
export function fixView(f: Finding, r: Report): FixView | undefined {
  const x = f.fixes[0];
  if (!x) return undefined;
  if (x.run) return { type: "cmd", text: x.run };
  const name = findingName(f);
  if (f.rule === "drift")
    return { type: "ask", text: `Compare the ${name} skill on ${machinesOf(f)} and keep one copy` };
  if (x.set) {
    const text = `${x.set.key}: ${String(x.set.value)}`;
    return { type: "set", text, file: x.path.split("/").at(-1)! };
  }
  if (f.rule === "heavy-instructions")
    return {
      type: "ask",
      text: `Shorten ${x.path} to under ${limit(r, "heavy-instructions")} characters`,
    };
  if (f.rule === "expensive-description")
    return {
      type: "ask",
      text: `Shorten the description of the ${name} skill to ${limit(r, "expensive-description")} characters`,
    };
  const verb = { remove: "Remove", dedupe: "Keep one copy of", shorten: "Shorten" } as const;
  return { type: "ask", text: `${verb[x.action as keyof typeof verb] ?? "Change"} ${x.path}` };
}
/** The fix as one line for a person or an agent. */
export function fixLine(f: Finding, r: Report) {
  const v = fixView(f, r);
  if (!v) return "";
  return v.type === "set" ? `Set ${v.text} in ${f.fixes[0]!.path}` : v.text;
}
/** The short verb a row links with. */
export function actionName(f: Finding) {
  if (f.rule === "dead-pack") return "Remove pack";
  if (f.rule === "drift") return "Sync";
  const a = f.fixes[0]?.action;
  return a === "hide-from-model"
    ? "Hide from model"
    : a === "dedupe"
      ? "Keep one"
      : a === "shorten"
        ? "Shorten"
        : a === "set"
          ? "Change setting"
          : "Remove";
}

export function agentPrompt(fs: Finding[], r: Report): string {
  const acts = fs.filter((f) => f.fixes.length);
  return (
    `loadsheet found ${plural(acts.length, "fix", "fixes")} in my agent setup. Show me the list, apply the ones I approve one at a time, and tell me what changed:\n` +
    acts
      .map(
        (f, i) =>
          `${i + 1}. ${findingName(f)}: ${fixLine(f, r)}${f.fixes.length > 1 ? ` (on ${list(f.fixes.flatMap((x) => (x.machine ? [x.machine] : [])))})` : ""}`,
      )
      .join("\n")
  );
}

/** Findings about one harness: those that name it, and those that name none. */
export const findingsOn = (r: Report, harness: string) =>
  r.findings.filter((f) => !f.where.length || f.where.some((w) => w.harness === harness));
/** What a person can act on in one harness, biggest saving first. */
export const fixesOn = (r: Report, harness: string) =>
  findingsOn(r, harness)
    .filter((f) => f.level !== "info" && f.fixes.length)
    .sort((a, b) => saved(b) - saved(a));
export const findingsFor = (r: Report, harness: string, l: Line) =>
  fixesOn(r, harness).filter(
    (f) => f.item === l.item || (f.rule === "dead-pack" && l.pack && f.pack === l.pack),
  );
export const saved = (f: Finding) => f.savesTokens?.value ?? 0;
export const saves = (fs: Finding[]) => fs.reduce((n, f) => n + saved(f), 0);

const SIGNAL: Record<string, string> = {
  listing: "what it lists",
  modelUse: "the model's calls",
  userUse: "your own calls",
  instructions: "instruction files",
  mcp: "MCP servers",
  tokens: "token counts",
};
/** What the report read and what it couldn't, one line each, for the folded coverage note. */
export function coverage(r: Report): string[] {
  const read = r.coverage.filter((c) => c.installed && c.sessions > 0);
  const idle = r.coverage.filter((c) => c.installed && c.sessions === 0);
  const harnesses = (cs: typeof read) => list([...new Set(cs.map((c) => harnessName(c.harness)))]);
  const machines = (cs: typeof read) => list([...new Set(cs.map((c) => c.machine))]);
  const out: string[] = [];
  if (read.length) out.push(`Read ${harnesses(read)} on ${machines(read)}.`);
  for (const c of idle)
    out.push(`${harnessName(c.harness)} on ${c.machine} is installed and had no sessions.`);
  for (const m of r.machines.filter((m) => !m.reachable)) out.push(`${m.name} was unreachable.`);
  for (const s of r.skipped)
    out.push(
      `Skipped ${ruleName(s.rule).toLowerCase()} on ${harnessName(s.harness)}: ${
        s.reason === "missing-signal" && s.missing?.length
          ? `it doesn't record ${list(s.missing.map((m) => SIGNAL[m] ?? m))}.`
          : "not enough sessions yet."
      }`,
    );
  for (const f of r.findings.filter((f) => f.level === "info"))
    out.push(
      `${f.where[0] ? `${harnessName(f.where[0].harness)} on ${f.where[0].machine}: ` : ""}${evidence(f, r)}`,
    );
  return out;
}
