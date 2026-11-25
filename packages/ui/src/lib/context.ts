import { harnessTokens, setupTokens } from "@loadsheet/core";
import type { Line, Sheet } from "@loadsheet/schema";
import type { InjectionKey } from "vue";
import { harnessName } from "./report";

/**
  What a new session started now loads, before you type: every installed line at its full tokens, plus the
  harness's own prompt. History (means over sessions, never-used flags) stays out of this view.
*/

export type SegId = "harness" | "instructions" | "skill" | "pskill" | "mcp" | "subagent";

export interface CItem {
  id: string;
  name: string;
  tokens: number;
  /** The skills group it sits in: personal, system, project or `plugin:<name>`. */
  group: string;
  project: boolean;
  path?: string;
  description?: string;
}
export interface Segment {
  id: SegId;
  label: string;
  short?: string;
  sub: string;
  tokens: number;
  items: CItem[];
}
export interface Context {
  total: number;
  /** What your own files add; the harness is the rest. */
  setup: number;
  /** The model's context window: the Report's, or 200k for a Report that predates it. */
  window: number;
  segments: Segment[];
}

/** The window a Report without `contextWindow` is drawn against. */
export const DEFAULT_WINDOW = 200_000;

const KINDS: { id: SegId; label: string; short?: string; sub: string }[] = [
  { id: "harness", label: "Harness", sub: "system prompt and built-in tools" },
  { id: "instructions", label: "Instructions", sub: "CLAUDE.md, AGENTS.md, memory" },
  { id: "skill", label: "Skills", sub: "names and descriptions" },
  {
    id: "pskill",
    label: "Project skills",
    short: "Project",
    sub: "skills that live in this project",
  },
  { id: "mcp", label: "MCP servers", short: "MCP", sub: "tool definitions" },
  { id: "subagent", label: "Subagents", short: "Agents", sub: "agent descriptions" },
];

/** Where each harness documents its own prompt. */
export const HDOC: Record<string, { label: string; url: string; what: string }> = {
  "claude-code": {
    label: "Built-in tools",
    url: "https://code.claude.com/docs/en/tools-reference",
    what: "Claude Code’s own instructions plus the definitions of its built-in tools (Read, Edit, Bash, Grep, Agent…). Run /context in Claude Code to see the split.",
  },
  codex: {
    label: "Codex prompt",
    url: "https://github.com/openai/codex/tree/main/codex-rs/core",
    what: "Codex’s base instructions for the model plus its built-in tools (shell, apply_patch, plan…). The prompt files are public in the Codex repository.",
  },
};

const pluginOf = (l: Line) =>
  l.pack?.split("/").pop() ?? (l.ref.name.includes(":") ? l.ref.name.split(":")[0]! : "plugin");

function groupOf(l: Line): string {
  if (l.scope === "project") return "project";
  if (l.scope === "plugin") return `plugin:${pluginOf(l)}`;
  return l.path?.includes("/.system/") ? "system" : "personal";
}

function segOf(l: Line): SegId {
  if (l.ref.kind === "skill") return l.scope === "project" ? "pskill" : "skill";
  return l.ref.kind;
}

export function contextOf(sheet: Sheet): Context {
  // A line with no scope is no longer installed anywhere: it would not load now.
  const lines = sheet.lines.filter((l) => l.scope);
  const segments: Segment[] = [];
  for (const k of KINDS) {
    if (k.id === "harness") continue;
    const items = lines
      .filter((l) => segOf(l) === k.id)
      .map((l): CItem => ({
        id: l.item,
        name: l.ref.name,
        tokens: l.tokens.value,
        group: groupOf(l),
        project: l.scope === "project",
        path: l.path,
        description: l.description,
      }))
      .sort((a, b) => Number(b.project) - Number(a.project) || b.tokens - a.tokens);
    const tokens = items.reduce((n, i) => n + i.tokens, 0);
    if (items.length) segments.push({ ...k, tokens, items });
  }
  if (segments.some((s) => s.id === "pskill")) {
    const skills = segments.find((s) => s.id === "skill");
    if (skills) skills.label = "Global skills";
  }
  const setup = setupTokens(sheet);
  const harness = harnessTokens(sheet) ?? 0;
  if (harness > 0) {
    segments.unshift({
      ...KINDS[0]!,
      label: harnessName(sheet.harness),
      tokens: harness,
      items: [],
    });
  }
  const total = setup + harness;
  const window = sheet.contextWindow ?? DEFAULT_WINDOW;
  return { total, setup, window: Math.max(window, total), segments };
}

const SRC: Record<string, string> = {
  personal: "Personal",
  system: "Built-in",
  project: "This project",
};
export const groupName = (k: string) =>
  SRC[k] ?? (k.startsWith("plugin:") ? `${k.slice(7)} plugin` : k);

/** The folder most personal skills sit in, such as ~/.claude/skills. */
export function groupNote(k: string, items: CItem[]): string {
  if (k === "system") return "ship with Codex";
  if (k.startsWith("plugin:")) return "installed plugin";
  if (k !== "personal") return "";
  const dirs = new Map<string, number>();
  for (const i of items) {
    const d = i.path?.replace(/\/[^/]+\/?$/, "");
    if (d) dirs.set(d, (dirs.get(d) ?? 0) + 1);
  }
  return [...dirs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/** The file a skill's or subagent's description is read from; a plugin's file by its place in the plugin. */
export function sourceFile(i: CItem): string | undefined {
  if (!i.path) return undefined;
  const file = /\.md$/i.test(i.path) ? i.path : `${i.path}/SKILL.md`;
  const inPlugin = i.group.startsWith("plugin:") && file.match(/\/((?:skills|agents)\/.+)$/);
  return inPlugin ? `the ${i.group.slice(7)} plugin’s ${inPlugin[1]}` : file;
}

/** Each segment's colour token. */
export const KVAR: Record<SegId, string> = {
  harness: "var(--k-harness)",
  instructions: "var(--k-instr)",
  skill: "var(--k-skill)",
  pskill: "var(--k-pskill)",
  mcp: "var(--k-mcp)",
  subagent: "var(--k-agent)",
};

export const firstSentence = (t: string) => t.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? t;

/** 51.9k, 200k, 1M. */
export const short = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`
      : String(Math.round(n));
export const tok = (n: number) => `${short(n)} tokens`;
export const share = (a: number, b: number) => {
  const p = (a / b) * 100;
  return p > 0 && p < 0.1 ? "<0.1%" : `${p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)}%`;
};
const NOUN: Record<SegId, [string, string]> = {
  harness: ["part", "parts"],
  pskill: ["skill", "skills"],
  skill: ["skill", "skills"],
  mcp: ["server", "servers"],
  subagent: ["agent", "agents"],
  instructions: ["file", "files"],
};
export const count = (n: number, k: SegId) => `${n} ${NOUN[k][n === 1 ? 0 : 1]}`;

/** What the map and the table share: the chosen segment, what is open, the search. */
export interface ViewState {
  sel: SegId | null;
  /** Open segments in the table. */
  open: Set<string>;
  /** Open skill groups, as `skill:<group>`. */
  src: Set<string>;
  /** Lists showing past their top five. */
  more: Set<string>;
  /** Items showing their whole description, as `<segment>:<item>`. */
  desc: Set<string>;
  all: boolean;
  q: string;
  /** The row the map just sent you to: a group key or `item:<segment>:<item>`. */
  flash: string | null;
}
export const freshView = (): ViewState => ({
  sel: null,
  open: new Set(["instructions", "skill", "pskill", "mcp", "subagent"]),
  src: new Set(),
  more: new Set(),
  desc: new Set(),
  all: false,
  q: "",
  flash: null,
});
export interface ContextView {
  st: ViewState;
  ctx: () => Context;
  harness: () => string;
  /** Switches to the table and shows this row there. */
  reveal: (seg: SegId, opts: { group?: string; item?: string; more?: boolean }) => void;
}
export const VIEW = Symbol("context-view") as InjectionKey<ContextView>;

/** Axis ticks for the window, about five of them, ending on the window itself. */
export function ticks(win: number): number[] {
  const step = [25_000, 50_000, 100_000, 250_000, 500_000].find((s) => win / s <= 5) ?? 500_000;
  const t: number[] = [];
  for (let v = 0; v < win - step * 0.35; v += step) t.push(v);
  t.push(win);
  return t;
}
