import { DEFAULT_WINDOW, harnessTokens, setupTokens } from "@loadsheet/core";
import type { Line, Sheet } from "@loadsheet/schema";
import type { InjectionKey } from "vue";
import { harnessName } from "./report";

/**
  What a new session started now loads, before you type: the startup cost of installed entries, plus the
  harness's own prompt when measured. History (means over sessions, never-used flags) stays out of this view.
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
  /** What this kind is, in words for someone who has never counted tokens. */
  about: string;
  tokens: number;
  items: CItem[];
}
export interface Context {
  /** Known tokens, including the built-ins when measured. */
  total: number;
  /** Whether startup tokens were measured, even if the built-in share is zero. */
  measured: boolean;
  /** What your own files add; the harness is the rest. */
  setup: number;
  /** The model's context window: the Report's, or 200k for a Report that predates it. */
  window: number;
  /** Space left in the window, unknown if built-ins weren't measured and setup doesn't fill it. */
  free: number | undefined;
  segments: Segment[];
}

const SKILLS_ABOUT =
  "Reusable instructions. The startup list can include skill names or short descriptions.";
const KINDS: { id: SegId; label: string; short?: string; sub: string; about: string }[] = [
  {
    id: "harness",
    label: "Harness",
    sub: "built-in instructions and tools",
    about: "The agent’s own instructions and tools. They load in every chat.",
  },
  {
    id: "instructions",
    label: "Instructions",
    sub: "CLAUDE.md, AGENTS.md, memory",
    about:
      "Files like CLAUDE.md or AGENTS.md with your rules. The agent can load the text or just list the file at startup.",
  },
  { id: "skill", label: "Skills", sub: "skill listings", about: SKILLS_ABOUT },
  {
    id: "pskill",
    label: "Project skills",
    short: "Project",
    sub: "skills that live in this project",
    about: SKILLS_ABOUT,
  },
  {
    id: "mcp",
    label: "MCP servers",
    short: "MCP",
    sub: "extra tool listings",
    about:
      "Servers that give the agent extra tools. At startup the agent may see only tool names, or more detail about the tools.",
  },
  {
    id: "subagent",
    label: "Subagents",
    short: "Agents",
    sub: "agent descriptions",
    about:
      "Helpers the agent can hand work to. The agent can list them at startup so it knows who to call.",
  },
];

/** What the "?" beside the headline says. */
export const TOKEN_ABOUT =
  "A token is a small piece of text, about ¾ of a word. Everything in a chat uses tokens.";

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
  const harness = harnessTokens(sheet);
  if (harness !== undefined && harness > 0) {
    segments.unshift({
      ...KINDS[0]!,
      label: harnessName(sheet.harness),
      tokens: harness,
      items: [],
    });
  }
  const total = setup + (harness ?? 0);
  const window = sheet.contextWindow ?? DEFAULT_WINDOW;
  const measured = harness !== undefined;
  const remaining = Math.max(0, window - total);
  const free = measured || remaining === 0 ? remaining : undefined;
  return { total, measured, setup, window, free, segments };
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

/** A sentence as text runs; `b` runs are the numbers and names worth bolding. */
export type Phrase = (string | { b: string })[];

/** Above this a single part is worth naming on its own. */
const BIG_PART = 5000;

/**
  One sentence on what this setup loads, for someone who has never counted tokens. It describes; it never tells the
  reader what to change.
*/
export function takeaway(c: Context, agent: string): Phrase {
  const used = Math.round((c.total / c.window) * 100);
  const { measured } = c;
  if (c.total > c.window)
    return [
      measured ? "That’s " : "Your setup alone uses ",
      { b: `${used}%` },
      " of the limit, more than the chat can hold.",
    ];
  if (used >= 50)
    return measured
      ? ["That’s ", { b: `${used}%` }, " of the limit, so there’s less room for a long chat."]
      : ["Your setup alone uses ", { b: `${used}%` }, " of the limit, not counting built-ins."];
  const seg = (id: SegId) => c.segments.find((s) => s.id === id);
  const skills = [seg("skill"), seg("pskill")].flatMap((s) => s?.items ?? []);
  const parts: { id: SegId; tokens: number; items: CItem[] }[] = [
    ...["instructions", "mcp", "subagent"].flatMap((id) => {
      const s = seg(id as SegId);
      return s ? [{ id: s.id, tokens: s.tokens, items: s.items }] : [];
    }),
    { id: "skill", tokens: skills.reduce((n, i) => n + i.tokens, 0), items: skills },
  ];
  const top = parts.sort((a, b) => b.tokens - a.tokens)[0]!;
  const loaded = top.items.filter((i) => i.tokens > 0);
  if (top.tokens > BIG_PART) {
    if (top.id === "mcp") {
      const server = [...loaded].sort((a, b) => b.tokens - a.tokens)[0]!;
      return [
        "Extra tools from MCP servers add the most. ",
        { b: server.name },
        " alone takes ",
        { b: tok(server.tokens) },
        " to make its tools available before you use them.",
      ];
    }
    if (top.id === "instructions")
      return [
        "Your instruction files add ",
        { b: tok(top.tokens) },
        ` before you type, from the rules or file listings ${agent} sees at startup.`,
      ];
    return [
      "Your ",
      { b: count(loaded.length, top.id) },
      " add ",
      { b: tok(top.tokens) },
      ` to ${agent}’s startup list, before you use them.`,
    ];
  }
  const harness = seg("harness")?.tokens ?? 0;
  if (!measured)
    return [
      "Your setup is light, but there’s no measurement for the built-in instructions and tools.",
    ];
  const free = [{ b: `${100 - used}%` }, " free for your chat."];
  return harness
    ? [
        `Your setup is light. ${agent} itself takes `,
        { b: tok(harness) },
        ", and you added ",
        { b: tok(c.setup) },
        ". That leaves ",
        ...free,
      ]
    : ["Your setup is light. It adds ", { b: tok(c.setup) }, ", which leaves ", ...free];
}
