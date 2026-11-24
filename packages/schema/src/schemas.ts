// Valibot schemas for the types in types.ts. Each description repeats a doc comment there, and the
// assertions at the bottom fail to compile when a schema and its type disagree.
// Scan and Report use loose objects so a reader keeps keys a newer writer added; Config uses strict
// objects so a typo is an error.
import * as v from "valibot";
import type {
  Cell,
  Config,
  Coverage,
  Item,
  Line,
  Report,
  ResolvedConfig,
  RuleId,
  Scan,
  SessionCell,
  Signal,
} from "./types.ts";

/** The rule ids, in the order a Report lists them. */
export const RULES = [
  "invisible-skill",
  "dead-skill",
  "manual-only",
  "expensive-description",
  "dead-pack",
  "duplicate",
  "heavy-instructions",
  "idle-mcp",
  "harness-mismatch",
  "drift",
  "short-history",
] as const satisfies readonly RuleId[];

/** The signals a harness can provide. */
export const SIGNALS = [
  "listing",
  "modelUse",
  "userUse",
  "instructions",
  "mcp",
  "tokens",
] as const satisfies readonly Signal[];

const KINDS = ["skill", "instructions", "mcp", "subagent"] as const;

const describe = <S extends v.GenericSchema>(schema: S, text: string) =>
  v.pipe(schema, v.description(text));

const count = (text: string) => v.pipe(v.number(), v.integer(), v.minValue(0), v.description(text));
const nonEmpty = (text: string) => v.pipe(v.string(), v.minLength(1), v.description(text));
const strings = (text: string) => describe(v.array(v.string()), text);

const isCalendarDay = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
};

const DaySchema = v.pipe(
  v.string(),
  v.isoDate("must be a day written YYYY-MM-DD"),
  v.check(isCalendarDay, "must be a real calendar day"),
  v.description("A UTC calendar day, written YYYY-MM-DD."),
);
const day = (text: string) => describe(DaySchema, text);

const timestamp = (text: string) =>
  v.pipe(
    v.string(),
    v.isoTimestamp("must be an ISO 8601 timestamp"),
    v.check((value) => isCalendarDay(value.slice(0, 10)), "must be a real calendar day"),
    v.description(text),
  );

const windowOf = (text: string) =>
  v.pipe(
    v.strictTuple([DaySchema, DaySchema]),
    v.check(([first, last]) => first <= last, "the first day must not be after the last"),
    v.description(text),
  );

// A home directory written out in full: /home/<user>, /Users/<user>, /var/home/<user>, /root, or a
// Windows drive. The schema cannot know a machine's home, so this catches the usual places; the
// writer replaces the real one with ~.
const HOME = String.raw`(?:/home/|/Users/|/var/home/|/root(?:/|$)|[A-Za-z]:[\\/])`;
const NOT_HOME = new RegExp(`^(?!${HOME})`);
const relativePath = (text: string) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.regex(NOT_HOME, "must be relative to the home directory (~/...), not an absolute home path"),
    v.description(text),
  );
const name = (text: string) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.regex(NOT_HOME, "must not be an absolute home path"),
    v.description(text),
  );

const version = (text: string) =>
  v.pipe(
    v.literal(1, (issue) =>
      typeof issue.input === "number" && issue.input > 1
        ? `was written by a newer loadsheet (schema ${issue.input}); update loadsheet to read it`
        : `must be 1, got ${issue.received}`,
    ),
    v.description(text),
  );

const SignalSchema = describe(
  v.picklist(SIGNALS),
  "A kind of evidence a harness's transcripts can provide.",
);
const GradeSchema = describe(
  v.picklist(["exact", "inferred", "none"]),
  "How well a harness provides a signal: read directly, inferred from indirect evidence, or not at all.",
);
const KindSchema = describe(
  v.picklist(KINDS),
  "What a piece of context is: a skill, an instruction file, an MCP server or a subagent.",
);
const ScopeSchema = describe(
  v.picklist(["user", "project", "plugin"]),
  "Where it is installed: the user's home, a project, or a plugin.",
);
const ManagedBySchema = describe(
  v.picklist(["fleetrc", "skills", "plugin", "hand"]),
  "What installed it and should change it: fleetrc, the skills CLI, a plugin, or the user by hand.",
);
const LevelSchema = describe(
  v.picklist(["cut", "fix", "info"]),
  "How strongly a finding asks for action: cut it, fix it, or know it.",
);

const IdSchema = v.pipe(
  v.string(),
  v.regex(
    new RegExp(`^(${KINDS.join("|")}):(?!${HOME}).+$`),
    "must be kind:name, where kind is skill, instructions, mcp or subagent and name is not an absolute home path",
  ),
  v.description("A piece of context's id, `${kind}:${name}`."),
);
const id = (text: string) => describe(IdSchema, text);

const RefSchema = v.pipe(
  v.looseObject({
    kind: describe(KindSchema, "What the piece of context is."),
    name: name("Its name, unique within its kind."),
  }),
  v.description("Names one piece of context."),
);

const TokensSchema = v.pipe(
  v.looseObject({
    value: count("The number of tokens."),
    basis: describe(
      v.picklist(["measured", "estimated"]),
      "measured: from usage a harness reported; estimated: from a character count.",
    ),
  }),
  v.description(
    "A token count and whether it was measured from a harness's usage or estimated from characters.",
  ),
);

const CharsSchema = v.pipe(
  v.looseObject({
    listed: count(
      "Characters it puts in the context of every session that lists or loads it: a skill's or subagent's name and description, an instruction file's whole text, an MCP server's instructions.",
    ),
    body: count(
      "Characters loaded only when it is invoked: the rest of a skill's or subagent's file; 0 for instruction files and MCP servers.",
    ),
  }),
  v.description(
    "A size in characters, split into what every session pays and what only a session that invokes it pays.",
  ),
);

const ItemSchema = v.pipe(
  v.looseObject({
    id: id("Its id, `${kind}:${name}`."),
    ref: describe(RefSchema, "Its kind and name."),
    harnesses: strings("Ids of the harnesses that load it from this path."),
    scope: describe(ScopeSchema, "Where it is installed."),
    pack: v.optional(name("Where it came from: a plugin name, `owner/repo`, or a fleetrc source.")),
    managedBy: describe(ManagedBySchema, "What installed it."),
    path: relativePath(
      "Its file or folder, relative to the home directory (`~/...`) or to the project.",
    ),
    digest: v.pipe(
      v.string(),
      v.regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256"),
      v.description("The sha256 of its file content, as lowercase hex."),
    ),
    chars: describe(
      CharsSchema,
      "Its size in characters: listed is paid by every session that lists or loads it, body only by a session that invokes it.",
    ),
    modelInvocable: describe(v.boolean(), "Whether the model may invoke it on its own."),
    description: v.optional(
      describe(v.string(), "Its description, in pack mode only; a Scan never carries it."),
    ),
  }),
  v.check(
    (item) => item.id === `${item.ref.kind}:${item.ref.name}`,
    "id must be ref.kind:ref.name",
  ),
  v.description(
    "One installed piece of context found on disk (or in a pack). The same id at two paths is two Items.",
  ),
);

const CellSchema = v.pipe(
  v.looseObject({
    day: day("The day the sessions started."),
    harness: nonEmpty("The harness id."),
    via: nonEmpty(
      "The entrypoint or originator that started the sessions, such as cli or an app's name.",
    ),
    item: id("The item's id."),
    sessions: count("Sessions that listed it (skill, mcp, subagent) or loaded it (instructions)."),
    bare: count("Of those sessions, how many listed it without its description."),
    chars: count("Characters it occupied, summed over those sessions."),
    byModel: count("Times the model invoked it."),
    byUser: count("Times the user invoked it."),
  }),
  v.check((cell) => cell.bare <= cell.sessions, "bare must not exceed sessions"),
  v.description(
    "Additive usage counters for one item, in one harness, on one day, through one entrypoint.",
  ),
);

const SessionCellSchema = v.pipe(
  v.looseObject({
    day: day("The day the sessions started."),
    harness: nonEmpty("The harness id."),
    via: nonEmpty("The entrypoint or originator that started the sessions."),
    sessions: count("Sessions started."),
    fixedTokens: count("First-request input tokens, summed over the sessions that reported them."),
    measured: count("Sessions that reported their first-request input tokens."),
  }),
  v.check((cell) => cell.measured <= cell.sessions, "measured must not exceed sessions"),
  v.description(
    "Additive session totals for one harness, day and entrypoint: the denominator for every share.",
  ),
);

const CoverageSchema = v.pipe(
  v.looseObject({
    machine: nonEmpty("The machine's name."),
    harness: nonEmpty("The harness id."),
    installed: describe(v.boolean(), "Whether the harness's home exists on that machine."),
    sessions: count("Sessions found in the window."),
    versions: strings("Harness versions seen in those sessions."),
    firstDay: v.optional(day("The first day with a session.")),
    lastDay: v.optional(day("The last day with a session.")),
    signals: v.pipe(
      v.looseObject({
        listing: GradeSchema,
        modelUse: GradeSchema,
        userUse: GradeSchema,
        instructions: GradeSchema,
        mcp: GradeSchema,
        tokens: GradeSchema,
      }),
      v.description("How well each signal is provided."),
    ),
  }),
  v.description("What one harness on one machine could tell."),
);

const scanSchema = v.pipe(
  v.looseObject({
    schema: version("The schema version, 1."),
    tool: nonEmpty("The tool and version that wrote it, such as loadsheet@0.0.1."),
    machine: nonEmpty("The machine's name."),
    scannedAt: timestamp("When it was scanned, as an ISO 8601 timestamp."),
    window: windowOf("The first and last day it covers, inclusive."),
    coverage: describe(v.array(CoverageSchema), "What each harness on this machine could tell."),
    items: describe(
      v.array(
        v.pipe(
          ItemSchema,
          v.check((item) => item.description === undefined, "a Scan must not carry a description"),
        ),
      ),
      "Installed pieces of context.",
    ),
    sessions: describe(v.array(SessionCellSchema), "Session totals."),
    cells: describe(v.array(CellSchema), "Usage counters."),
  }),
  v.description(
    "One machine's counters for a window: what is installed and how it was used, with no text. Scans of the same machine merge by summing their counters; Scans of different machines stay separate, and a Report is built from the list.",
  ),
);

// Config objects reject keys they do not know, so a typo is reported instead of ignored.
const strict = <E extends v.ObjectEntries>(entries: E) =>
  v.strictObject(entries, (issue) =>
    issue.expected === "never"
      ? `unknown key ${issue.received}`
      : `must be an object, got ${issue.received}`,
  );

// Rule thresholds. Each rule's entries build both its strict, partial Config form and its
// complete ResolvedConfig form, so the two cannot list different options.
const ruleEntries = {
  "invisible-skill": {
    minSessions: count("Least sessions that listed it, default 5."),
    bareShare: v.pipe(
      v.number(),
      v.minValue(0),
      v.maxValue(1),
      v.description("Least share of those that listed it bare, default 0.5."),
    ),
  },
  "dead-skill": {
    minSessions: count("Least sessions that listed it, default 20."),
    minDays: count("Least days of history, default 14."),
  },
  "manual-only": { minUserUses: count("Least user invocations, default 3.") },
  "expensive-description": { maxChars: count("Most listed characters, default 300.") },
  "dead-pack": { minSkills: count("Least skills in the pack, default 5.") },
  duplicate: {},
  "heavy-instructions": { maxChars: count("Most characters, default 12000.") },
  "idle-mcp": { minSessions: count("Least sessions that listed it, default 20.") },
  "harness-mismatch": {
    minSessions: count("A harness with fewer sessions in the window counts as unused, default 1."),
  },
  drift: {},
  "short-history": { minDays: count("Least days of history, default 30.") },
} as const satisfies Record<RuleId, v.ObjectEntries>;

const ruleDocs: Record<RuleId, string> = {
  "invisible-skill": "A skill listed without its description in most sessions.",
  "dead-skill": "A skill listed for weeks and never invoked.",
  "manual-only": "A model-invocable skill only the user invokes.",
  "expensive-description": "A skill whose listing entry is longer than it should be.",
  "dead-pack": "A pack none of whose skills is used.",
  duplicate: "The same piece of context installed more than once.",
  "heavy-instructions": "An instruction file larger than it should be.",
  "idle-mcp": "An MCP server listed and never called.",
  "harness-mismatch": "Context installed for a harness that is not used.",
  drift: "The same piece of context differs between machines.",
  "short-history": "Too little history to judge.",
};

const configRule = <E extends v.ObjectEntries>(entries: E, doc: string) =>
  v.optional(describe(v.union([v.literal(false), v.partial(strict(entries))]), doc));

const resolvedRule = <E extends v.ObjectEntries>(entries: E, doc: string) =>
  describe(
    v.looseObject({ enabled: describe(v.boolean(), "Whether the rule runs."), ...entries }),
    doc,
  );

const configSchema = v.pipe(
  strict({
    $schema: v.optional(describe(v.string(), "The JSON Schema this file follows.")),
    window: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.description("Days of history to read, default 30."),
      ),
    ),
    harnesses: v.optional(strings("Read only these harness ids.")),
    via: v.optional(
      v.pipe(
        strict({
          include: v.optional(strings("Read only sessions from these entrypoints.")),
          exclude: v.optional(strings("Skip sessions from these entrypoints.")),
        }),
        v.description("Filter sessions by entrypoint or originator."),
      ),
    ),
    ignore: v.optional(describe(v.array(IdSchema), "Item ids never reported.")),
    rules: v.optional(
      v.pipe(
        strict({
          "invisible-skill": configRule(
            ruleEntries["invisible-skill"],
            ruleDocs["invisible-skill"],
          ),
          "dead-skill": configRule(ruleEntries["dead-skill"], ruleDocs["dead-skill"]),
          "manual-only": configRule(ruleEntries["manual-only"], ruleDocs["manual-only"]),
          "expensive-description": configRule(
            ruleEntries["expensive-description"],
            ruleDocs["expensive-description"],
          ),
          "dead-pack": configRule(ruleEntries["dead-pack"], ruleDocs["dead-pack"]),
          duplicate: configRule(ruleEntries["duplicate"], ruleDocs["duplicate"]),
          "heavy-instructions": configRule(
            ruleEntries["heavy-instructions"],
            ruleDocs["heavy-instructions"],
          ),
          "idle-mcp": configRule(ruleEntries["idle-mcp"], ruleDocs["idle-mcp"]),
          "harness-mismatch": configRule(
            ruleEntries["harness-mismatch"],
            ruleDocs["harness-mismatch"],
          ),
          drift: configRule(ruleEntries["drift"], ruleDocs["drift"]),
          "short-history": configRule(ruleEntries["short-history"], ruleDocs["short-history"]),
        }),
        v.description("Per rule: false turns it off, an object overrides its thresholds."),
      ),
    ),
  }),
  v.description("User config file. Every field is optional."),
);

const ResolvedConfigSchema = v.pipe(
  v.looseObject({
    window: v.pipe(v.number(), v.integer(), v.minValue(1), v.description("Days of history read.")),
    harnesses: v.optional(strings("Only these harness ids were read, when set.")),
    via: v.pipe(
      v.looseObject({
        include: strings("Only sessions from these entrypoints were read, when not empty."),
        exclude: strings("Sessions from these entrypoints were skipped."),
      }),
      v.description("The entrypoint filter."),
    ),
    ignore: describe(v.array(IdSchema), "Item ids never reported."),
    rules: v.pipe(
      v.looseObject({
        "invisible-skill": resolvedRule(
          ruleEntries["invisible-skill"],
          ruleDocs["invisible-skill"],
        ),
        "dead-skill": resolvedRule(ruleEntries["dead-skill"], ruleDocs["dead-skill"]),
        "manual-only": resolvedRule(ruleEntries["manual-only"], ruleDocs["manual-only"]),
        "expensive-description": resolvedRule(
          ruleEntries["expensive-description"],
          ruleDocs["expensive-description"],
        ),
        "dead-pack": resolvedRule(ruleEntries["dead-pack"], ruleDocs["dead-pack"]),
        duplicate: resolvedRule(ruleEntries["duplicate"], ruleDocs["duplicate"]),
        "heavy-instructions": resolvedRule(
          ruleEntries["heavy-instructions"],
          ruleDocs["heavy-instructions"],
        ),
        "idle-mcp": resolvedRule(ruleEntries["idle-mcp"], ruleDocs["idle-mcp"]),
        "harness-mismatch": resolvedRule(
          ruleEntries["harness-mismatch"],
          ruleDocs["harness-mismatch"],
        ),
        drift: resolvedRule(ruleEntries["drift"], ruleDocs["drift"]),
        "short-history": resolvedRule(ruleEntries["short-history"], ruleDocs["short-history"]),
      }),
      v.description("Each rule, whether it runs, and its thresholds."),
    ),
  }),
  v.description("Config with every default applied; this is what a Report carries."),
);

const LineSchema = v.pipe(
  v.looseObject({
    item: id("Its id."),
    ref: describe(RefSchema, "Its kind and name."),
    scope: v.optional(
      describe(
        ScopeSchema,
        "Where it is installed; absent when it is no longer installed on any machine read.",
      ),
    ),
    pack: v.optional(name("Where it came from.")),
    managedBy: v.optional(
      describe(
        ManagedBySchema,
        "What installed it; absent when it is no longer installed on any machine read.",
      ),
    ),
    machines: strings("Machines where it is installed or was seen."),
    path: v.optional(
      relativePath(
        "Its file or folder, relative to the home directory or the project; absent when it is no longer installed on any machine read.",
      ),
    ),
    chars: describe(
      CharsSchema,
      "Its size in characters; body is 0 when it is no longer installed, because nothing is left to measure.",
    ),
    tokens: describe(TokensSchema, "What it adds to every session's context."),
    exposure: v.pipe(
      v.looseObject({
        sessions: count("Sessions that listed or loaded it."),
        share: v.pipe(
          v.number(),
          v.minValue(0),
          v.maxValue(1),
          v.description("Those sessions as a share, 0 to 1, of the harness's sessions."),
        ),
        bare: count("Of those sessions, how many listed it without its description."),
      }),
      v.check((exposure) => exposure.bare <= exposure.sessions, "bare must not exceed sessions"),
      v.description("How many sessions it was in."),
    ),
    use: v.pipe(
      v.looseObject({
        byModel: count("Times the model invoked it."),
        byUser: count("Times the user invoked it."),
        lastUsed: v.optional(day("The start day of the last session that invoked it.")),
      }),
      v.description("How often it was invoked."),
    ),
    description: v.optional(describe(v.string(), "Its description, in pack mode only.")),
  }),
  v.check(
    (line) => line.item === `${line.ref.kind}:${line.ref.name}`,
    "item must be ref.kind:ref.name",
  ),
  v.description("One piece of context on a harness's sheet, aggregated over machines."),
);

const SheetSchema = v.pipe(
  v.looseObject({
    harness: nonEmpty("The harness id."),
    sessions: count("Its sessions in the window, over all machines."),
    fixedTokens: v.optional(
      describe(
        TokensSchema,
        "Tokens every session starts with, averaged over the sessions that reported them; absent when none did.",
      ),
    ),
    lines: describe(v.array(LineSchema), "One line per piece of context."),
  }),
  v.description("What one harness loads, line by line."),
);

const FixSchema = v.pipe(
  v.looseObject({
    machine: v.optional(
      nonEmpty(
        "The machine to change; absent in pack mode, where the change goes to the pack's source.",
      ),
    ),
    action: describe(
      v.picklist(["remove", "hide-from-model", "shorten", "dedupe", "set"]),
      "What to do.",
    ),
    path: relativePath(
      "The file or folder to change, relative to the home directory or the project.",
    ),
    run: v.optional(nonEmpty("The exact command, when one exists.")),
    set: v.optional(
      v.pipe(
        v.looseObject({
          key: nonEmpty("The key to set."),
          value: describe(
            v.union([v.string(), v.number(), v.boolean()]),
            "The value to set it to.",
          ),
        }),
        v.description("The key and value to set, for set and hide-from-model."),
      ),
    ),
  }),
  v.check(
    (fix) =>
      (fix.action !== "set" && fix.action !== "hide-from-model") ||
      fix.set !== undefined ||
      fix.run !== undefined,
    "set and hide-from-model need set or run",
  ),
  v.description("One change the user's agent should make."),
);

const FindingSchema = v.pipe(
  v.looseObject({
    id: nonEmpty("A stable id, `${rule}:${item ?? pack ?? harness}`."),
    rule: nonEmpty(
      "The rule that found it: a RuleId, or the id of a rule a newer loadsheet added.",
    ),
    level: describe(LevelSchema, "How strongly it asks for action."),
    item: v.optional(
      id(
        "The item it is about; absent for pack-level and harness-level findings such as dead-pack and short-history.",
      ),
    ),
    pack: v.optional(name("The pack it is about, for dead-pack.")),
    where: describe(
      v.array(
        v.pipe(
          v.looseObject({
            machine: nonEmpty("The machine's name."),
            harness: nonEmpty("The harness id."),
          }),
          v.description("A machine and harness."),
        ),
      ),
      "Where it applies; empty in pack mode.",
    ),
    evidence: describe(v.record(v.string(), v.number()), "The numbers the rule judged on."),
    savesTokens: v.optional(describe(TokensSchema, "Tokens it would save per session.")),
    fixes: describe(v.array(FixSchema), "Changes that resolve it."),
  }),
  v.check((finding) => finding.id.startsWith(`${finding.rule}:`), "id must start with rule:"),
  v.description("Something a rule found."),
);

const SkippedSchema = v.pipe(
  v.looseObject({
    rule: nonEmpty("The rule: a RuleId, or the id of a rule a newer loadsheet added."),
    harness: nonEmpty("The harness id."),
    reason: describe(
      v.picklist(["missing-signal", "not-enough-data"]),
      "missing-signal: the harness does not provide a signal the rule needs; not-enough-data: too few sessions.",
    ),
    missing: v.optional(
      describe(v.array(SignalSchema), "The signals it needs and the harness does not provide."),
    ),
  }),
  v.description("A rule that did not run on a harness, and why."),
);

const reportSchema = v.pipe(
  v.looseObject({
    schema: version("The schema version, 1."),
    tool: nonEmpty("The tool and version that wrote it, such as loadsheet@0.0.1."),
    generatedAt: timestamp("When it was generated, as an ISO 8601 timestamp."),
    mode: describe(
      v.picklist(["local", "fleet", "pack"]),
      "local: this machine; fleet: several machines; pack: a public pack, without usage.",
    ),
    source: v.optional(relativePath("In pack mode, the directory name or GitHub URL read.")),
    machines: describe(
      v.array(
        v.pipe(
          v.looseObject({
            name: nonEmpty("The machine's name."),
            reachable: describe(v.boolean(), "Whether its Scan was read."),
            scannedAt: v.optional(timestamp("When it was scanned.")),
            error: v.optional(describe(v.string(), "Why it could not be read.")),
          }),
          v.description("A machine a Report read from."),
        ),
      ),
      "The machines read; empty in pack mode.",
    ),
    window: windowOf("The first and last day it covers, inclusive."),
    config: describe(ResolvedConfigSchema, "The config it ran with."),
    coverage: describe(
      v.array(CoverageSchema),
      "What each harness on each machine could tell; empty in pack mode.",
    ),
    sheet: describe(v.array(SheetSchema), "One sheet per harness, aggregated over machines."),
    findings: describe(v.array(FindingSchema), "What the rules found."),
    skipped: describe(v.array(SkippedSchema), "Rules that did not run, per harness."),
  }),
  v.forward(
    v.check(
      (report) =>
        report.mode === "pack" ||
        report.sheet.every((sheet) => sheet.lines.every((line) => line.description === undefined)),
      "a line carries a description only in pack mode",
    ),
    ["sheet"],
  ),
  v.forward(
    v.check(
      (report) =>
        report.mode === "pack" ||
        report.findings.every((finding) => finding.fixes.every((fix) => fix.machine !== undefined)),
      "outside pack mode every fix names its machine",
    ),
    ["findings"],
  ),
  v.description("What loadsheet found: one sheet per harness and the findings, with no text."),
);

// Compile-time checks that each schema's output is exactly its type. Loose objects add a
// `[key: string]: unknown` index signature to the output; Strip removes it (and only it) first.
type Strip<T> = T extends readonly unknown[]
  ? { [K in keyof T]: Strip<T[K]> }
  : T extends object
    ? { [K in keyof T as string extends K ? (unknown extends T[K] ? never : K) : K]: Strip<T[K]> }
    : T;
type Same<A, B> =
  (<G>() => G extends Strip<A> ? 1 : 2) extends <G>() => G extends Strip<B> ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type SchemasMatchTypes = [
  Assert<Same<v.InferOutput<typeof scanSchema>, Scan>>,
  Assert<Same<v.InferOutput<typeof ItemSchema>, Item>>,
  Assert<Same<v.InferOutput<typeof CellSchema>, Cell>>,
  Assert<Same<v.InferOutput<typeof SessionCellSchema>, SessionCell>>,
  Assert<Same<v.InferOutput<typeof CoverageSchema>, Coverage>>,
  Assert<Same<v.InferOutput<typeof LineSchema>, Line>>,
  Assert<Same<v.InferOutput<typeof ResolvedConfigSchema>, ResolvedConfig>>,
  Assert<Same<v.InferOutput<typeof configSchema>, Config>>,
  Assert<Same<v.InferOutput<typeof reportSchema>, Report>>,
];

// The exported schemas carry only their output type. Their inferred valibot types would put
// ~100 KB of declarations in the package's d.ts; the assertions above check those types instead.
/** Validates a Scan with valibot; see parseScan. */
export const ScanSchema: v.GenericSchema<unknown, Scan> = scanSchema;
/** Validates a Report with valibot; see parseReport. */
export const ReportSchema: v.GenericSchema<unknown, Report> = reportSchema;
/** Validates a config file with valibot; see parseConfig. */
export const ConfigSchema: v.GenericSchema<unknown, Config> = configSchema;
