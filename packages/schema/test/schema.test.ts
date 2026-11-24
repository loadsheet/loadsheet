import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import formats from "ajv-formats";
import { describe, expect, it } from "vite-plus/test";
import {
  defaultConfig,
  parseConfig,
  parseId,
  parseReport,
  parseScan,
  refId,
  resolveConfig,
  RULES,
  SchemaError,
  type Report,
} from "../src/index.ts";
import { jsonSchemas } from "../scripts/json-schema.ts";

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const example = (name: string) => read(`../../../examples/${name}`);
const committed = (name: string) => read(`../schema/${name}`);
const clone = <T>(value: T): T => structuredClone(value);

const ajv = new Ajv({ allErrors: true, strict: true });
formats.default(ajv);
const validators = new Map(
  ["report.v1.json", "scan.v1.json", "config.v1.json"].map((file) => [
    file,
    ajv.compile(committed(file) as object),
  ]),
);

describe.each([
  ["report.example.json", "report.v1.json", parseReport],
  ["report.pack.example.json", "report.v1.json", parseReport],
  ["scan.example.json", "scan.v1.json", parseScan],
  ["loadsheet.config.example.json", "config.v1.json", parseConfig],
] as const)("examples/%s", (name, schemaFile, parse) => {
  it("parses", () => {
    expect(() => parse(example(name))).not.toThrow();
  });

  it(`validates against ${schemaFile}`, () => {
    const validate = validators.get(schemaFile)!;
    const valid = validate(example(name));
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });
});

describe("JSON Schema files", () => {
  it("match the valibot schemas (run `pnpm --filter @loadsheet/schema generate` when this fails)", () => {
    for (const [name, schema] of Object.entries(jsonSchemas())) {
      expect(committed(name), name).toEqual(schema);
    }
  });

  it("describe every field with a doc comment from types.ts", () => {
    const types = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8").replace(
      /\s+/g,
      " ",
    );
    const descriptions = new Set<string>();
    const collect = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "description" && typeof value === "string") descriptions.add(value);
          else collect(value);
        }
      }
    };
    Object.values(jsonSchemas()).forEach(collect);
    const missing = [...descriptions].filter((text) => !types.includes(text));
    expect(missing).toEqual([]);
  });

  it("forbid unknown keys in a config and allow them in a Report", () => {
    expect(committed("config.v1.json")).toMatchObject({ additionalProperties: false });
    expect(committed("report.v1.json")).not.toHaveProperty("additionalProperties");
  });
});

const fleet = () => clone(example("report.example.json")) as Report;
const issuesOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaError);
    return (error as SchemaError).issues;
  }
  throw new Error("expected a SchemaError");
};

describe("parsing", () => {
  it("rejects a document from a newer loadsheet with only that reason", () => {
    const report = { ...fleet(), schema: 2, sheet: "changed shape" };
    expect(() => parseReport(report)).toThrow(/written by a newer loadsheet \(schema 2\)/);
    expect(issuesOf(() => parseReport(report))).toHaveLength(1);
    expect(() => parseScan({ schema: 3 })).toThrow(/newer loadsheet/);
  });

  it.each(["/home/ada/.claude/skills/x", "/Users/ada/.claude/skills/x", "C:\\Users\\ada\\x"])(
    "rejects the absolute home path %s in Item.path and Fix.path",
    (path) => {
      const scan = clone(example("scan.example.json")) as { items: { path: string }[] };
      scan.items[0]!.path = path;
      expect(issuesOf(() => parseScan(scan))).toContainEqual({
        path: "$.items[0].path",
        message: expect.stringMatching(/not an absolute home path/),
      });

      const report = fleet();
      report.findings[0]!.fixes[0]!.path = path;
      expect(issuesOf(() => parseReport(report)).map((issue) => issue.path)).toEqual([
        "$.findings[0].fixes[0].path",
      ]);
    },
  );

  it.each(["2026-13-01", "2026-02-30", "26-11-01", "2026-11-01T00:00:00Z"])(
    "rejects the day %s",
    (day) => {
      const report = fleet();
      report.window[1] = day;
      expect(issuesOf(() => parseReport(report)).map((issue) => issue.path)).toContain(
        "$.window[1]",
      );
    },
  );

  it("rejects a count of bare sessions above the sessions", () => {
    const report = fleet();
    const exposure = report.sheet[0]!.lines[0]!.exposure;
    exposure.bare = exposure.sessions + 1;
    expect(issuesOf(() => parseReport(report))).toContainEqual({
      path: "$.sheet[0].lines[0].exposure",
      message: "bare must not exceed sessions",
    });
  });

  it("keeps unknown keys on a Report", () => {
    const report = { ...fleet(), addedLater: { x: 1 } };
    report.sheet[0]!.lines[0] = { ...report.sheet[0]!.lines[0]!, alsoNew: true } as never;
    const parsed = parseReport(report) as Report & Record<string, unknown>;
    expect(parsed.addedLater).toEqual({ x: 1 });
    expect(parsed.sheet[0]!.lines[0]).toHaveProperty("alsoNew", true);
  });

  it("rejects an unknown rule id in a config", () => {
    expect(issuesOf(() => parseConfig({ rules: { "dead-skils": false } }))).toEqual([
      { path: '$.rules["dead-skils"]', message: 'unknown key "dead-skils"' },
    ]);
  });

  it("rejects an unknown threshold and an unknown top-level key in a config", () => {
    expect(issuesOf(() => parseConfig({ rules: { "dead-skill": { minSesions: 3 } } }))).toEqual([
      { path: '$.rules["dead-skill"].minSesions', message: 'unknown key "minSesions"' },
    ]);
    expect(issuesOf(() => parseConfig({ windw: 14 })).map((issue) => issue.path)).toEqual([
      "$.windw",
    ]);
  });
});

describe("resolveConfig", () => {
  it("resolves an empty config to the defaults", () => {
    expect(resolveConfig({})).toEqual(defaultConfig);
    expect(resolveConfig()).toEqual(defaultConfig);
  });

  it("turns a rule off and keeps its thresholds", () => {
    expect(resolveConfig({ rules: { "dead-skill": false } }).rules["dead-skill"]).toEqual({
      ...defaultConfig.rules["dead-skill"],
      enabled: false,
    });
  });

  it("merges a partial override over the defaults", () => {
    const resolved = resolveConfig(parseConfig(example("loadsheet.config.example.json")));
    expect(resolved.window).toBe(45);
    expect(resolved.via).toEqual({ include: [], exclude: ["t3code"] });
    expect(resolved.rules["dead-skill"]).toEqual({ enabled: true, minSessions: 40, minDays: 14 });
    expect(resolved.rules["short-history"].enabled).toBe(false);
    expect(resolved.rules["idle-mcp"]).toEqual(defaultConfig.rules["idle-mcp"]);
  });

  it("returns objects the caller may change without touching the defaults", () => {
    resolveConfig().rules["dead-skill"].minDays = 1;
    expect(defaultConfig.rules["dead-skill"].minDays).toBe(14);
  });
});

describe("ids", () => {
  it("round-trips a name that contains a colon", () => {
    const ref = { kind: "skill", name: "data-toolkit:csv-clean" } as const;
    expect(parseId(refId(ref))).toEqual(ref);
  });

  it.each(["skill", "skill:", "agent:x"])("rejects %s", (id) => {
    expect(() => parseId(id)).toThrow(/Invalid id/);
  });
});

describe("examples/report.example.json is coherent", () => {
  const report = parseReport(example("report.example.json"));
  const lines = report.sheet.flatMap((sheet) => sheet.lines);

  it("uses the default config, so its evidence can be checked against default thresholds", () => {
    expect(report.config).toEqual(defaultConfig);
  });

  it("has a finding for every rule, each about an item on some sheet", () => {
    expect(new Set(report.findings.map((finding) => finding.rule))).toEqual(new Set(RULES));
    for (const finding of report.findings) {
      expect(RULES).toContain(finding.rule);
      if (finding.item) expect(lines.map((line) => line.item)).toContain(finding.item);
      if (finding.pack) expect(lines.map((line) => line.pack)).toContain(finding.pack);
      expect(finding.id).toBe(
        `${finding.rule}:${finding.item ?? finding.pack ?? finding.where[0]!.harness}`,
      );
    }
  });

  it("keeps a line seen in sessions but no longer installed, without scope, owner or path", () => {
    const gone = lines.filter((line) => !line.path);
    expect(gone.length).toBeGreaterThan(0);
    for (const line of gone) {
      expect(line.scope).toBeUndefined();
      expect(line.managedBy).toBeUndefined();
      expect(line.exposure.sessions).toBeGreaterThan(0);
      expect(report.findings.map((finding) => finding.item)).not.toContain(line.item);
    }
  });

  it("estimates each line's tokens from the characters every session pays", () => {
    for (const line of lines) {
      if (line.ref.kind === "instructions" || line.ref.kind === "mcp")
        expect(line.chars.body).toBe(0);
      expect(line.tokens.value, line.item).toBe(Math.round(line.chars.listed / 4));
    }
  });

  it("gives every line a share of its sheet's sessions", () => {
    for (const sheet of report.sheet) {
      for (const { exposure } of sheet.lines) {
        expect(exposure.share).toBeGreaterThanOrEqual(0);
        expect(exposure.share).toBeLessThanOrEqual(1);
        expect(exposure.share).toBeCloseTo(exposure.sessions / sheet.sessions, 3);
      }
    }
  });

  it("totals each sheet's sessions from its coverage", () => {
    for (const sheet of report.sheet) {
      const covered = report.coverage.filter((row) => row.harness === sheet.harness);
      expect(covered.reduce((sum, row) => sum + row.sessions, 0)).toBe(sheet.sessions);
    }
  });
});

describe("examples/report.pack.example.json reads no machine", () => {
  const report = parseReport(example("report.pack.example.json"));

  it("names no machine in machines, coverage, where or fixes", () => {
    expect(report.mode).toBe("pack");
    expect(report.machines).toEqual([]);
    expect(report.coverage).toEqual([]);
    for (const finding of report.findings) {
      expect(finding.where).toEqual([]);
      for (const fix of finding.fixes) expect(fix).not.toHaveProperty("machine");
    }
  });
});

describe("examples/scan.example.json is coherent", () => {
  const scan = parseScan(example("scan.example.json"));
  const key = (row: { day: string; harness: string; via: string }) =>
    `${row.day} ${row.harness} ${row.via}`;
  const sessions = new Map(scan.sessions.map((row) => [key(row), row.sessions]));

  it("has one sessions row per day, harness and entrypoint, inside the window", () => {
    expect(sessions.size).toBe(scan.sessions.length);
    const [first, last] = scan.window;
    for (const row of [...scan.sessions, ...scan.cells]) {
      expect(row.day >= first && row.day <= last, row.day).toBe(true);
    }
  });

  it("counts each cell's item among the items and its sessions within its sessions row", () => {
    const items = new Set(scan.items.map((item) => item.id));
    for (const cell of scan.cells) {
      expect(items, cell.item).toContain(cell.item);
      expect(sessions.get(key(cell)), key(cell)).toBeGreaterThanOrEqual(cell.sessions);
      expect(cell.bare).toBeLessThanOrEqual(cell.sessions);
    }
  });

  it("totals each coverage row from its harness's sessions rows", () => {
    for (const row of scan.coverage) {
      expect(row.machine).toBe(scan.machine);
      const total = scan.sessions
        .filter((cell) => cell.harness === row.harness)
        .reduce((sum, cell) => sum + cell.sessions, 0);
      expect(total, row.harness).toBe(row.sessions);
    }
  });

  it("covers every kind and both harnesses", () => {
    expect(new Set(scan.items.map((item) => item.ref.kind))).toEqual(
      new Set(["skill", "instructions", "mcp", "subagent"]),
    );
    expect(new Set(scan.items.flatMap((item) => item.harnesses))).toEqual(
      new Set(["claude-code", "codex"]),
    );
  });
});
