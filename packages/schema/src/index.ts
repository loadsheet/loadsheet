import * as v from "valibot";
import { ConfigSchema, isHomePath, ReportSchema, RULES, SIGNALS, ScanSchema } from "./schemas.ts";
import type { Config, Id, Kind, Ref, Report, ResolvedConfig, Scan } from "./types.ts";

export type * from "./types.ts";
export { ConfigSchema, isHomePath, ReportSchema, RULES, SIGNALS, ScanSchema };

/** One reason a document did not validate, at a JSON path such as `$.sheet[0].lines[3].path`. */
export interface SchemaIssue {
  path: string;
  message: string;
}

/** Thrown by parseScan, parseReport and parseConfig; its message lists every issue with its path. */
export class SchemaError extends Error {
  readonly issues: SchemaIssue[];

  constructor(what: string, issues: SchemaIssue[]) {
    super(
      `Invalid ${what}:\n${issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n")}`,
    );
    this.name = "SchemaError";
    this.issues = issues;
  }
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

type PathItem = NonNullable<v.BaseIssue<unknown>["path"]>[number];

const pathOf = (items: readonly PathItem[]) =>
  items.reduce((path, { key }) => {
    if (typeof key === "number") return `${path}[${key}]`;
    if (typeof key === "string" && IDENTIFIER.test(key)) return `${path}.${key}`;
    return `${path}[${JSON.stringify(key)}]`;
  }, "$");

// A union reports one generic issue. When an option got past its type check (its issues sit
// deeper than the union), those issues say what is wrong; their paths start at the union.
const leaves = (issue: v.BaseIssue<unknown>, prefix: readonly PathItem[] = []): SchemaIssue[] => {
  const path = [...prefix, ...(issue.path ?? [])];
  const deeper =
    issue.type === "union" ? (issue.issues ?? []).filter((sub) => sub.path?.length) : [];
  if (deeper.length) return deeper.flatMap((sub) => leaves(sub, path));
  return [{ path: pathOf(path), message: issue.message }];
};

const parser =
  <S extends v.GenericSchema>(schema: S, what: string) =>
  (input: unknown): v.InferOutput<S> => {
    // A newer writer may have changed anything, so its version is the only issue worth reporting.
    if (typeof input === "object" && input !== null && "schema" in input) {
      const version = input.schema;
      if (typeof version === "number" && version > 1) {
        throw new SchemaError(what, [
          {
            path: "$.schema",
            message: `was written by a newer loadsheet (schema ${version}); update loadsheet to read it`,
          },
        ]);
      }
    }
    const result = v.safeParse(schema, input);
    if (result.success) return result.output;
    throw new SchemaError(
      what,
      result.issues.flatMap((issue) => leaves(issue)),
    );
  };

/** Validates a Scan; keys it does not know are kept. */
export const parseScan: (input: unknown) => Scan = parser(ScanSchema, "Scan");
/** Validates a Report; keys it does not know are kept. */
export const parseReport: (input: unknown) => Report = parser(ReportSchema, "Report");
/** Validates a config file; a key it does not know is an error. */
export const parseConfig: (input: unknown) => Config = parser(ConfigSchema, "config");

/** A piece of context's id, `${kind}:${name}`. */
export const refId = (ref: Ref): Id => `${ref.kind}:${ref.name}`;

const KINDS: readonly string[] = ["skill", "instructions", "mcp", "subagent"] satisfies Kind[];

/** Splits an id into its kind and name; throws when the kind is unknown or the name is empty. */
export const parseId = (id: Id): Ref => {
  const colon = id.indexOf(":");
  const kind = id.slice(0, colon);
  const name = id.slice(colon + 1);
  if (colon === -1 || !KINDS.includes(kind) || name === "") {
    throw new Error(
      `Invalid id ${JSON.stringify(id)}: expected kind:name, where kind is ${KINDS.join(", ")}`,
    );
  }
  return { kind: kind as Kind, name };
};

const DEFAULT_RULES: ResolvedConfig["rules"] = {
  "invisible-skill": { enabled: true, minSessions: 5, bareShare: 0.5 },
  "dead-skill": { enabled: true, minSessions: 20, minDays: 14 },
  "manual-only": { enabled: true, minUserUses: 3 },
  "expensive-description": { enabled: true, maxChars: 300 },
  "dead-pack": { enabled: true, minSkills: 5 },
  duplicate: { enabled: true },
  "heavy-instructions": { enabled: true, maxChars: 12000 },
  "idle-mcp": { enabled: true, minSessions: 20 },
  "harness-mismatch": { enabled: true, minSessions: 1 },
  drift: { enabled: true },
  "short-history": { enabled: true, minDays: 30 },
};

/** Applies every default to a config. The result shares no objects with its input or the defaults. */
export const resolveConfig = (config: Config = {}): ResolvedConfig => {
  const rules = structuredClone(DEFAULT_RULES);
  for (const rule of RULES) {
    const override = config.rules?.[rule];
    if (override === false) rules[rule].enabled = false;
    else if (override) {
      // An option set to undefined keeps its default.
      const set = Object.entries(override).filter(([, value]) => value !== undefined);
      Object.assign(rules[rule], Object.fromEntries(set));
    }
  }
  const resolved: ResolvedConfig = {
    window: config.window ?? 30,
    via: { include: [...(config.via?.include ?? [])], exclude: [...(config.via?.exclude ?? [])] },
    ignore: [...(config.ignore ?? [])],
    rules,
  };
  if (config.harnesses) resolved.harnesses = [...config.harnesses];
  return resolved;
};

/** Every default: what an empty config resolves to. */
export const defaultConfig: ResolvedConfig = resolveConfig();
