// The public contract. schemas.ts mirrors every type here and is compile-time-checked against it;
// each doc comment is repeated there as the JSON Schema description.

/** A UTC calendar day, written YYYY-MM-DD. */
export type Day = string;

/** A kind of evidence a harness's transcripts can provide. */
export type Signal = "listing" | "modelUse" | "userUse" | "instructions" | "mcp" | "tokens";

/** How well a harness provides a signal: read directly, inferred from indirect evidence, or not at all. */
export type Grade = "exact" | "inferred" | "none";

/** What a piece of context is: a skill, an instruction file, an MCP server or a subagent. */
export type Kind = "skill" | "instructions" | "mcp" | "subagent";

/** Names one piece of context. */
export interface Ref {
  /** What the piece of context is. */
  kind: Kind;
  /** Its name, unique within its kind. */
  name: string;
}

/** A piece of context's id, `${kind}:${name}`. */
export type Id = string;

/** Where it is installed: the user's home, a project, or a plugin. */
export type Scope = "user" | "project" | "plugin";

/** What installed it and should change it: fleetrc, the skills CLI, a plugin, or the user by hand. */
export type ManagedBy = "fleetrc" | "skills" | "plugin" | "hand";

/** A token count and whether it was measured from a harness's usage or estimated from characters. */
export interface Tokens {
  /** The number of tokens. */
  value: number;
  /** measured: from usage a harness reported; estimated: from a character count. */
  basis: "measured" | "estimated";
}

/** One installed piece of context found on disk (or in a pack). The same id at two paths is two Items. */
export interface Item {
  /** Its id, `${kind}:${name}`. */
  id: Id;
  /** Its kind and name. */
  ref: Ref;
  /** Ids of the harnesses that load it from this path. */
  harnesses: string[];
  /** Where it is installed. */
  scope: Scope;
  /** Where it came from: a plugin name, `owner/repo`, or a fleetrc source. */
  pack?: string;
  /** What installed it. */
  managedBy: ManagedBy;
  /** Its file or folder, relative to the home directory (`~/...`) or to the project. */
  path: string;
  /** The paths of the other Items of this machine that removing this one would take or break, worked out on the machine's disk; absent when that is not known. */
  reaches?: string[];
  /** The sha256 of its file content, as lowercase hex. */
  digest: string;
  /** Its size in characters: listed is paid by every session that lists or loads it, body only by a session that invokes it. */
  chars: Chars;
  /** Whether the model may invoke it on its own. */
  modelInvocable: boolean;
  /** Its description, in pack mode only; a Scan never carries it. */
  description?: string;
}

/** A size in characters, split into what every session pays and what only a session that invokes it pays. */
export interface Chars {
  /** Characters it puts in the context of every session that lists or loads it: a skill's or subagent's name and description, an instruction file's whole text, an MCP server's instructions. */
  listed: number;
  /** Characters loaded only when it is invoked: the rest of a skill's or subagent's file; 0 for instruction files and MCP servers. */
  body: number;
}

/** Additive usage counters for one item, in one harness, on one day, through one entrypoint. */
export interface Cell {
  /** The day the sessions started. */
  day: Day;
  /** The harness id. */
  harness: string;
  /** The entrypoint or originator that started the sessions, such as cli or an app's name. */
  via: string;
  /** The item's id. */
  item: Id;
  /** Sessions that listed it (skill, mcp, subagent) or loaded it (instructions). */
  sessions: number;
  /** Of those sessions, how many listed it without its description. */
  bare: number;
  /** Characters it occupied, summed over those sessions. */
  chars: number;
  /** Times the model invoked it. */
  byModel: number;
  /** Times the user invoked it. */
  byUser: number;
}

/** Additive session totals for one harness, day and entrypoint: the denominator for every share. */
export interface SessionCell {
  /** The day the sessions started. */
  day: Day;
  /** The harness id. */
  harness: string;
  /** The entrypoint or originator that started the sessions. */
  via: string;
  /** Sessions started. */
  sessions: number;
  /** First-request input tokens, summed over the sessions that reported them. */
  fixedTokens: number;
  /** Sessions that reported their first-request input tokens. */
  measured: number;
}

/** What one harness on one machine could tell. */
export interface Coverage {
  /** The machine's name. */
  machine: string;
  /** The harness id. */
  harness: string;
  /** Whether the harness's home exists on that machine. */
  installed: boolean;
  /** Sessions found in the window. */
  sessions: number;
  /** Harness versions seen in those sessions. */
  versions: string[];
  /** The first day with a session. */
  firstDay?: Day;
  /** The last day with a session. */
  lastDay?: Day;
  /** How well each signal is provided. */
  signals: Record<Signal, Grade>;
}

/** One machine's counters for a window: what is installed and how it was used, with no text. Scans of the same machine merge by summing their counters; Scans of different machines stay separate, and a Report is built from the list. */
export interface Scan {
  /** The schema version, 1. */
  schema: 1;
  /** The tool and version that wrote it, such as loadsheet@0.0.1. */
  tool: string;
  /** The machine's name. */
  machine: string;
  /** When it was scanned, as an ISO 8601 timestamp. */
  scannedAt: string;
  /** The first and last day it covers, inclusive. */
  window: [Day, Day];
  /** What each harness on this machine could tell. */
  coverage: Coverage[];
  /** Installed pieces of context. */
  items: Item[];
  /** Session totals. */
  sessions: SessionCell[];
  /** Usage counters. */
  cells: Cell[];
}

/** A rule's id. */
export type RuleId =
  | "invisible-skill"
  | "dead-skill"
  | "manual-only"
  | "expensive-description"
  | "dead-pack"
  | "duplicate"
  | "heavy-instructions"
  | "idle-mcp"
  | "harness-mismatch"
  | "drift"
  | "short-history";

/** How strongly a finding asks for action: cut it, fix it, or know it. */
export type Level = "cut" | "fix" | "info";

/** User config file. Every field is optional. */
export interface Config {
  /** The JSON Schema this file follows. */
  $schema?: string;
  /** Days of history to read, default 30. */
  window?: number;
  /** Read only these harness ids. */
  harnesses?: string[];
  /** Filter sessions by entrypoint or originator. */
  via?: {
    /** Read only sessions from these entrypoints. */
    include?: string[];
    /** Skip sessions from these entrypoints. */
    exclude?: string[];
  };
  /** Item ids never reported. */
  ignore?: string[];
  /** Per rule: false turns it off, an object overrides its thresholds. */
  rules?: { [R in RuleId]?: false | Partial<RuleOptions[R]> };
}

/** Each rule's thresholds. */
export interface RuleOptions {
  /** A skill listed without its description in most sessions. */
  "invisible-skill": {
    /** Least sessions that listed it, default 5. */
    minSessions: number;
    /** Least share of those that listed it bare, default 0.5. */
    bareShare: number;
  };
  /** A skill listed for weeks and never invoked. */
  "dead-skill": {
    /** Least sessions that listed it, default 20. */
    minSessions: number;
    /** Least days of history, default 14. */
    minDays: number;
  };
  /** A model-invocable skill only the user invokes. */
  "manual-only": {
    /** Least user invocations, default 3. */
    minUserUses: number;
  };
  /** A skill whose listing entry is longer than it should be. */
  "expensive-description": {
    /** Most listed characters, default 300. */
    maxChars: number;
  };
  /** A pack none of whose skills is used. */
  "dead-pack": {
    /** Least skills in the pack, default 5. */
    minSkills: number;
  };
  /** The same piece of context installed more than once. */
  duplicate: {};
  /** An instruction file larger than it should be. */
  "heavy-instructions": {
    /** Most characters, default 12000. */
    maxChars: number;
  };
  /** An MCP server listed and never called. */
  "idle-mcp": {
    /** Least sessions that listed it, default 20. */
    minSessions: number;
  };
  /** Context installed for a harness that is not used. */
  "harness-mismatch": {
    /** A harness with fewer sessions in the window counts as unused, default 1. */
    minSessions: number;
  };
  /** The same piece of context differs between machines. */
  drift: {};
  /** Too little history to judge. */
  "short-history": {
    /** Least days of history, default 30. */
    minDays: number;
  };
}

/** Config with every default applied; this is what a Report carries. */
export interface ResolvedConfig {
  /** Days of history read. */
  window: number;
  /** Only these harness ids were read, when set. */
  harnesses?: string[];
  /** The entrypoint filter. */
  via: {
    /** Only sessions from these entrypoints were read, when not empty. */
    include: string[];
    /** Sessions from these entrypoints were skipped. */
    exclude: string[];
  };
  /** Item ids never reported. */
  ignore: string[];
  /** Each rule, whether it runs, and its thresholds. */
  rules: {
    [R in RuleId]: {
      /** Whether the rule runs. */
      enabled: boolean;
    } & RuleOptions[R];
  };
}

/** One piece of context on a harness's sheet, aggregated over machines. */
export interface Line {
  /** Its id. */
  item: Id;
  /** Its kind and name. */
  ref: Ref;
  /** Where it is installed; absent when it is no longer installed on any machine read. */
  scope?: Scope;
  /** Where it came from. */
  pack?: string;
  /** What installed it; absent when it is no longer installed on any machine read. */
  managedBy?: ManagedBy;
  /** Machines where it is installed or was seen; empty in pack mode. */
  machines: string[];
  /** Its file or folder, relative to the home directory or the project; absent when it is no longer installed on any machine read. */
  path?: string;
  /** Its size in characters; body is 0 when it is no longer installed, because nothing is left to measure. */
  chars: Chars;
  /** What it adds to every session's context. */
  tokens: Tokens;
  /** How many sessions it was in. */
  exposure: Exposure;
  /** How often it was invoked. */
  use: Use;
  /** Its description, in pack mode only. */
  description?: string;
}

/** How many sessions a line was in. */
export interface Exposure {
  /** Sessions that listed or loaded it. */
  sessions: number;
  /** Those sessions as a share, 0 to 1, of the harness's sessions. */
  share: number;
  /** Of those sessions, how many listed it without its description. */
  bare: number;
}

/** How often a line was invoked. */
export interface Use {
  /** Times the model invoked it. */
  byModel: number;
  /** Times the user invoked it. */
  byUser: number;
  /** The start day of the last session that invoked it. */
  lastUsed?: Day;
}

/** What one harness loads, line by line. */
export interface Sheet {
  /** The harness id. */
  harness: string;
  /** Its sessions in the window, over all machines. */
  sessions: number;
  /** Tokens every session starts with, averaged over the sessions that reported them; absent when none did. */
  fixedTokens?: Tokens;
  /** One line per piece of context. */
  lines: Line[];
}

/** One change the user's agent should make. */
export interface Fix {
  /** The machine to change; absent in pack mode, where the change goes to the pack's source. */
  machine?: string;
  /** What to do. */
  action: "remove" | "hide-from-model" | "shorten" | "dedupe" | "set";
  /** The file or folder to change, relative to the home directory or the project. */
  path: string;
  /** The exact command, when one exists. */
  run?: string;
  /** The key and value to set, for set and hide-from-model. */
  set?: {
    /** The key to set. */
    key: string;
    /** The value to set it to. */
    value: string | number | boolean;
  };
}

/** Something a rule found. */
export interface Finding {
  /** A stable id, `${rule}:${item ?? pack ?? harness}`. */
  id: string;
  /** The rule that found it: a RuleId, or the id of a rule a newer loadsheet added. */
  rule: string;
  /** How strongly it asks for action. */
  level: Level;
  /** The item it is about; absent for pack-level and harness-level findings such as dead-pack and short-history. */
  item?: Id;
  /** The pack it is about, for dead-pack. */
  pack?: string;
  /** Where it applies; empty in pack mode. */
  where: Where[];
  /** The numbers the rule judged on. */
  evidence: Record<string, number>;
  /** Tokens it would save per session. */
  savesTokens?: Tokens;
  /** Changes that resolve it. */
  fixes: Fix[];
}

/** A machine and harness. */
export interface Where {
  /** The machine's name. */
  machine: string;
  /** The harness id. */
  harness: string;
}

/** A rule that did not run on a harness, and why. */
export interface Skipped {
  /** The rule: a RuleId, or the id of a rule a newer loadsheet added. */
  rule: string;
  /** The harness id. */
  harness: string;
  /** missing-signal: the harness does not provide a signal the rule needs; not-enough-data: too few sessions. */
  reason: "missing-signal" | "not-enough-data";
  /** The signals it needs and the harness does not provide. */
  missing?: Signal[];
}

/** A machine a Report read from. */
export interface Machine {
  /** The machine's name. */
  name: string;
  /** Whether its Scan was read. */
  reachable: boolean;
  /** When it was scanned. */
  scannedAt?: string;
  /** Why it could not be read. */
  error?: string;
}

/** What loadsheet found: one sheet per harness and the findings, with no text. */
export interface Report {
  /** The schema version, 1. */
  schema: 1;
  /** The tool and version that wrote it, such as loadsheet@0.0.1. */
  tool: string;
  /** When it was generated, as an ISO 8601 timestamp. */
  generatedAt: string;
  /** local: this machine; fleet: several machines; pack: a public pack, without usage. */
  mode: "local" | "fleet" | "pack";
  /** In pack mode, the directory name or GitHub URL read. */
  source?: string;
  /** The machines read; empty in pack mode. */
  machines: Machine[];
  /** The first and last day it covers, inclusive. */
  window: [Day, Day];
  /** The config it ran with. */
  config: ResolvedConfig;
  /** What each harness on each machine could tell; empty in pack mode. */
  coverage: Coverage[];
  /** One sheet per harness, aggregated over machines. */
  sheet: Sheet[];
  /** What the rules found. */
  findings: Finding[];
  /** Rules that did not run, per harness. */
  skipped: Skipped[];
}
