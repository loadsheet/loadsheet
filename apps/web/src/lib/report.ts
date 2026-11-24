import { parseReport, type Finding, type Line, type Report, type Sheet } from "@loadsheet/schema";
import { shallowRef } from "vue";
import example from "../../../../examples/report.example.json";
import packExample from "../../../../examples/report.pack.example.json";
import mattpocock from "../data/pack.mattpocock-skills.json";
import pstack from "../data/pack.pstack.json";

export type { Finding, Line, Report, Sheet };

/** `loadsheet --ui` and `loadsheet build` inline the report as `<script type="application/json" id="report">`. */
function inlined(): Report | undefined {
  const el = document.getElementById("report");
  return el?.textContent ? parseReport(JSON.parse(el.textContent)) : undefined;
}

const fromPage = inlined();
export const report = shallowRef<Report>(fromPage ?? parseReport(example));
export const isExample = shallowRef(!fromPage);
/**
  Packs this page can show without a server. The two named ones were read from the repositories' own
  plugin manifests and SKILL.md files (names, descriptions and sizes), the way the pack checker will.
*/
export const packs: Record<string, { report: Report; title: string; by?: string }> = {
  "mattpocock/skills": { report: parseReport(mattpocock), title: "Matt Pocock's skills", by: "Matt Pocock" },
  "cursor/plugins/pstack": { report: parseReport(pstack), title: "pstack", by: "Lauren Tan" },
  "northwind-ai/agent-skills": { report: parseReport(packExample), title: "agent-skills" },
};
/** Where `/` goes when the CLI inlined a report: the user's own report, or the pack it read. */
export const home = (() => {
  if (!fromPage) return undefined;
  if (fromPage.mode !== "pack") return "/report";
  const slug = packSlug(fromPage.source ?? "") ?? fromPage.source?.split(/[\\/]/).filter(Boolean).at(-1) ?? "pack";
  packs[slug] = { report: fromPage, title: slug.split("/").at(-1)! };
  return `/pack/${slug}`;
})();
/** `github.com/owner/repo`, `owner/repo` or `github.com/owner/repo/tree/main/dir` → `owner/repo[/dir]`. */
export function packSlug(input: string): string | undefined {
  const m = input.trim().replace(/^https?:\/\//, "").replace(/^github\.com\//, "").match(/^([\w.-]+)\/([\w.-]+)(?:\/tree\/[^/]+((?:\/[\w.-]+)+))?/);
  return m ? `${m[1]}/${m[2]!.replace(/\.git$/, "")}${m[3] ?? ""}` : undefined;
}
/** Tokens a pack adds to every session once installed: what the model is shown before it uses anything. */
export const packTokens = (r: Report) => r.sheet[0]!.lines.reduce((n, l) => n + l.tokens.value, 0);

/*
  A shared report rides in the URL: `#/report/overview?r=<deflate-raw, base64url>`.
  It is the same Report the page already shows, counters and names only, and the fragment never reaches a server.
*/
async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  return new Uint8Array(await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream)).arrayBuffer());
}
export async function shareLink(r: Report, path = "/report/overview", h?: string) {
  const z = await pipe(new TextEncoder().encode(JSON.stringify(r)), new CompressionStream("deflate-raw"));
  let bin = "";
  for (const b of z) bin += String.fromCharCode(b);
  const code = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${location.origin}${location.pathname}#${path}?${h ? `h=${encodeURIComponent(h)}&` : ""}r=${code}`;
}
async function fromLink(code: string) {
  const bin = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
  const z = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return parseReport(JSON.parse(new TextDecoder().decode(await pipe(z, new DecompressionStream("deflate-raw")))));
}
/** Set when the URL carried a report this page couldn't read, so the page can say so instead of showing the example. */
export const linkError = shallowRef<string>();
/** True while the report on screen came from a shared link. */
export const shared = shallowRef(false);
/** Resolves once a report in the URL, if any, is loaded; main.ts mounts after it. */
export const ready = (async () => {
  const code = new URLSearchParams(location.hash.split("?")[1] ?? "").get("r");
  if (!code || fromPage) return;
  try {
    report.value = await fromLink(code);
    isExample.value = false;
    shared.value = true;
  } catch (e) {
    linkError.value = e instanceof Error ? e.message : String(e);
  }
})();

/** Reads a report.json the user dropped or picked. Throws a SchemaError with every issue's path. */
export async function openFile(file: File) {
  const next = parseReport(JSON.parse(await file.text()));
  report.value = next;
  isExample.value = false;
  shared.value = false;
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
export const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** Tokens a SKILL.md body adds when invoked: the report gives characters, so this is an estimate. */
export const bodyTokens = (l: Line) => Math.round(l.chars.body / 4);
export const uses = (l: Line) => l.use.byModel + l.use.byUser;
export const isUsed = (l: Line) => uses(l) > 0;
/** What a line adds to the average session: its tokens times the share of sessions it was in. */
export const perSession = (l: Line) => l.tokens.value * l.exposure.share;
export const itemName = (id: string) => id.replace(/^(skill|mcp|subagent|instructions):/, "");
export const findingName = (f: Finding) =>
  f.item ? itemName(f.item) : (f.pack ?? (f.where[0] ? harnessName(f.where[0].harness) : f.rule));
/** "5 skills, 2 subagents and 1 instruction file", leaving out kinds with none. */
export function kinds(ls: Line[]): string {
  const parts = (
    [
      ["skill", "skill"],
      ["subagent", "subagent"],
      ["instructions", "instruction file"],
      ["mcp", "MCP server"],
    ] as const
  )
    .map(([k, w]) => [ls.filter((l) => l.ref.kind === k).length, w] as const)
    .filter(([n]) => n)
    .map(([n, w]) => plural(n, w));
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "nothing");
}
/** A plugin skill is named `pack:skill`; inside its pack the prefix is noise. */
export const shortName = (l: Line) => (l.pack && l.ref.name.startsWith(`${l.pack.split("/").pop()}:`) ? l.ref.name.slice(l.ref.name.indexOf(":") + 1) : l.ref.name);

// ─── what every session starts with, by kind ───

export type KindId = "harness" | "instr" | "mcp" | "agents" | "used" | "dead";
export interface Segment {
  id: KindId;
  name: string;
  what: string;
  color: string;
  tokens: number;
  lines: Line[];
}

const KINDS: { id: Exclude<KindId, "harness">; name: string; color: string; what: string; test: (l: Line) => boolean }[] = [
  { id: "instr", name: "Instructions", color: "--k-instr", what: "CLAUDE.md, AGENTS.md and the files they pull in. Sent in every session of the project they belong to.", test: (l) => l.ref.kind === "instructions" },
  { id: "mcp", name: "MCP servers", color: "--k-mcp", what: "Tool names and schemas from your MCP servers. Sent in every session that has the server.", test: (l) => l.ref.kind === "mcp" },
  { id: "agents", name: "Subagents", color: "--k-agents", what: "The subagents the model can call, by name and description.", test: (l) => l.ref.kind === "subagent" },
  { id: "used", name: "Skills you use", color: "--k-used", what: "Each skill's name and description is listed every session. These were used at least once.", test: (l) => l.ref.kind === "skill" && isUsed(l) },
  { id: "dead", name: "Skills never used", color: "--k-dead", what: "Listed in every session, and no session in the window used them.", test: (l) => l.ref.kind === "skill" && !isUsed(l) },
];

export interface Context {
  sheet: Sheet;
  fixed: number;
  basis: "measured" | "estimated";
  yours: number;
  segments: Segment[];
}

export function context(sheet: Sheet | undefined): Context | undefined {
  if (!sheet || !sheet.lines.length) return undefined;
  const segments: Segment[] = KINDS.map((k) => {
    const lines = sheet.lines.filter(k.test).sort((a, b) => perSession(b) - perSession(a));
    return { id: k.id, name: k.name, what: k.what, color: k.color, lines, tokens: lines.reduce((n, l) => n + perSession(l), 0) };
  });
  const yours = segments.reduce((n, s) => n + s.tokens, 0);
  const fixed = sheet.fixedTokens?.value ?? yours;
  const own: Segment = {
    id: "harness",
    name: `${harnessName(sheet.harness)} itself`,
    what: `System prompt, built-in tools and environment. ${harnessName(sheet.harness)} sends these every session; you can't change them, so loadsheet only counts them.`,
    color: "--k-harness",
    tokens: Math.max(0, fixed - yours),
    lines: [],
  };
  return { sheet, fixed, basis: sheet.fixedTokens?.basis ?? "estimated", yours, segments: sheet.fixedTokens ? [own, ...segments] : segments };
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
export const ruleName = (rule: string) => RULE[rule] ?? rule.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

export function evidence(f: Finding): string {
  const e = f.evidence;
  const n = (k: string) => fmt(e[k] ?? 0);
  switch (f.rule) {
    case "invisible-skill":
      return `Listed without its description in ${n("bare")} of ${n("sessions")} sessions, so the model can't tell when to use it.`;
    case "dead-skill":
      return `Not used once in ${n("sessions")} sessions over ${n("days")} days.`;
    case "manual-only":
      return `You called it ${n("byUser")} times; the model never did. Hide it from the model and keep the slash command.`;
    case "expensive-description":
      return `Its listing is ${n("listedChars")} characters, over the ${fmt(report.value.config.rules["expensive-description"].maxChars)} limit.`;
    case "dead-pack":
      return `${n("skills")} skills, none used in ${n("sessions")} sessions.`;
    case "duplicate":
      return `${n("copies")} copies installed; every session lists both.`;
    case "heavy-instructions":
      return `${n("chars")} characters, over the ${fmt(report.value.config.rules["heavy-instructions"].maxChars)} limit, loaded in ${n("sessions")} sessions.`;
    case "idle-mcp":
      return `${n("calls")} tool calls in ${n("sessions")} sessions. Its tools are listed in every one.`;
    case "harness-mismatch":
      return `Installed for a harness with ${n("sessions")} sessions in the window.`;
    case "drift":
      return `${n("variants")} different versions across ${n("machines")} machines.`;
    case "short-history":
      return `Only ${n("days")} days and ${n("sessions")} sessions so far; rules that need a month of history wait.`;
    default:
      return Object.entries(e).map(([k, v]) => `${k} ${fmt(v)}`).join(" · ");
  }
}

/** One line a person or agent can act on: the exact command when there is one, else the change in words. */
export function fixText(f: Finding): { cmd?: string; note?: string } {
  const x = f.fixes[0];
  if (!x) return {};
  if (x.run) return { cmd: x.run };
  switch (x.action) {
    case "hide-from-model":
    case "set":
      return { note: `Set ${x.set?.key}: ${String(x.set?.value)} in ${x.path}` };
    case "shorten":
      return { note: `Shorten ${x.path}` };
    case "dedupe":
      return { note: `Keep one copy of ${x.path}` };
    case "remove":
      return { note: `Remove ${x.path}` };
  }
}
export const fixLine = (f: Finding) => {
  const t = fixText(f);
  return t.cmd ?? t.note ?? "";
};

export function agentPrompt(fs: Finding[]): string {
  const acts = fs.filter((f) => f.fixes.length);
  return (
    `loadsheet found ${plural(acts.length, "fix", "fixes")} in my agent setup. Show me the list, apply the ones I approve one at a time, and tell me what changed:\n` +
    acts.map((f, i) => `${i + 1}. ${findingName(f)}: ${fixLine(f)}${f.fixes.length > 1 ? ` (on ${f.fixes.map((x) => x.machine).join(" and ")})` : ""}`).join("\n")
  );
}

export const findingsFor = (r: Report, l: Line) =>
  r.findings.filter((f) => f.item === l.item || (f.rule === "dead-pack" && l.pack && f.pack === l.pack));
export const saves = (fs: Finding[]) => fs.reduce((n, f) => n + (f.savesTokens?.value ?? 0), 0);
