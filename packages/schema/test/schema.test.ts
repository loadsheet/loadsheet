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
  shareableReport,
  type Report,
  type Scan,
} from "../src/index.ts";
import { jsonSchemas } from "../scripts/json-schema.ts";

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const example = (name: string) => read(`../../../examples/${name}`);
const committed = (name: string) => read(`../schema/${name}`);
const clone = <T>(value: T): T => structuredClone(value);

// strictRequired would reject `required` in a condition, away from the object's own properties.
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
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

  it.each([
    "/home/ada/.claude/skills/x",
    "/Users/ada/.claude/skills/x",
    "/var/home/ada/.claude/skills/x",
    "//home/ada/.claude/skills/x",
    "/./home/ada/.claude/skills/x",
    "/var//home/ada/.claude/skills/x",
    "/root/.codex/skills/x",
    "/root",
    "C:\\Users\\ada\\x",
  ])("rejects the absolute home path %s in Item.path and Fix.path", (path) => {
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
  });

  it("accepts a path outside any home, such as a project under /srv", () => {
    const scan = clone(example("scan.example.json")) as { items: { path: string }[] };
    scan.items[0]!.path = "/srv/app/.claude/skills/x";
    expect(() => parseScan(scan)).not.toThrow();
  });

  it("rejects an absolute home path in a name, an id and a pack", () => {
    const scan = clone(example("scan.example.json")) as Scan;
    const item = scan.items.find((entry) => entry.ref.kind === "instructions")!;
    const index = scan.items.indexOf(item);
    item.ref.name = "/home/ada/work/infra/CLAUDE.md";
    item.id = `instructions:${item.ref.name}`;
    item.pack = "/Users/ada/skills";
    scan.cells[0]!.item = "instructions:/root/CLAUDE.md";
    expect(issuesOf(() => parseScan(scan)).map((issue) => issue.path)).toEqual([
      `$.items[${index}].id`,
      `$.items[${index}].ref.name`,
      `$.items[${index}].pack`,
      "$.cells[0].item",
    ]);
  });

  it("keeps a one-letter plugin prefix and a name that only mentions home", () => {
    for (const name of ["x:deploy", "home/notes", "rooted"]) {
      expect(() => parseConfig({ ignore: [`skill:${name}`] })).not.toThrow();
    }
  });

  it("takes a description on a skill or subagent only, in a Scan and on a line", () => {
    const scan = clone(example("scan.example.json")) as Scan;
    expect(scan.items.some((item) => item.description !== undefined)).toBe(true);
    expect(validators.get("scan.v1.json")!(scan)).toBe(true);
    scan.items[0]!.description = "Use when the deploy fails.";
    expect(issuesOf(() => parseScan(scan))).toEqual([
      { path: "$.items[0]", message: "only a skill or subagent carries a description" },
    ]);

    const report = fleet();
    expect(report.sheet[0]!.lines.some((line) => line.description !== undefined)).toBe(true);
    report.sheet[0]!.lines[0]!.description = "Use when the deploy fails.";
    expect(issuesOf(() => parseReport(report))).toEqual([
      {
        path: "$.sheet[0].lines[0]",
        message: "only a skill or subagent line carries a description",
      },
    ]);
  });

  it("reads a Scan and a Report written before usage: no usage, and neither signal graded", () => {
    const scan = clone(example("scan.example.json")) as Scan;
    const report = fleet();
    for (const doc of [scan, report]) {
      delete doc.usage;
      for (const row of doc.coverage) {
        const signals = row.signals as Partial<typeof row.signals>;
        delete signals.usage;
        delete signals.cacheTtl;
        delete row.settings;
      }
    }
    expect(validators.get("scan.v1.json")!(scan)).toBe(true);
    expect(validators.get("report.v1.json")!(report)).toBe(true);
    for (const parsed of [parseScan(scan), parseReport(report)]) {
      expect("usage" in parsed).toBe(false);
      for (const row of parsed.coverage) {
        expect(row.signals).toMatchObject({ usage: "none", cacheTtl: "none" });
      }
    }
  });

  it("reads usage and settings as the examples write them", () => {
    const scan = clone(example("scan.example.json")) as Scan;
    const report = fleet();
    expect(parseScan(scan).usage).toEqual(scan.usage);
    expect(parseReport(report).usage).toEqual(report.usage);
    expect(scan.usage!.sessions.length && scan.usage!.tokens.length).toBeTruthy();
    expect(parseScan(scan).coverage.find((row) => row.settings)?.settings).toEqual(
      scan.coverage.find((row) => row.settings)!.settings,
    );
  });

  it.each(["/home/ada/work/web", "/Users/ada/web", "/root/web", "C:\\Users\\ada\\web"])(
    "rejects the absolute home path %s as a usage project",
    (path) => {
      const scan = clone(example("scan.example.json")) as Scan;
      scan.usage!.sessions[0]!.project = path;
      scan.usage!.tokens[0]!.project = path;
      expect(issuesOf(() => parseScan(scan)).map((issue) => issue.path)).toEqual([
        "$.usage.sessions[0].project",
        "$.usage.tokens[0].project",
      ]);
      expect(validators.get("scan.v1.json")!(scan)).toBe(false);
    },
  );

  it.each(["acme/web", "~/notes", "~", "/srv/app", "unknown"])(
    "takes %s as a usage project",
    (path) => {
      const scan = clone(example("scan.example.json")) as Scan;
      scan.usage!.sessions[0]!.project = path;
      expect(parseScan(scan).usage!.sessions[0]!.project).toBe(path);
      expect(validators.get("scan.v1.json")!(scan)).toBe(true);
    },
  );

  it("a token cell with only unsplit validates", () => {
    const scan = clone(example("scan.example.json")) as Scan;
    const cell = {
      ...scan.usage!.tokens[0]!,
      requests: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRewrite: 0,
      unsplit: 1_234_567,
    };
    scan.usage!.tokens = [cell];
    expect(parseScan(scan).usage!.tokens).toEqual([cell]);
    expect(validators.get("scan.v1.json")!(scan)).toBe(true);
    scan.usage!.tokens = [{ ...cell, unsplit: -1 }];
    expect(issuesOf(() => parseScan(scan)).map((issue) => issue.path)).toEqual([
      "$.usage.tokens[0].unsplit",
    ]);
    expect(validators.get("scan.v1.json")!(scan)).toBe(false);
  });

  it("rejects a usage part above its whole, a thread it does not know and a store path", () => {
    const scan = clone(example("scan.example.json")) as Scan;
    const tokens = scan.usage!.tokens[0]!;
    tokens.reasoning = tokens.output + 1;
    tokens.cacheWrite1h = tokens.cacheWrite;
    const sessions = scan.usage!.sessions[0]!;
    sessions.compacted = sessions.compactions + 1;
    (scan.usage!.sessions[1] as { thread: string }).thread = "side";
    scan.coverage[0]!.unread = ["/home/ada/.local/share/opencode/opencode.db"];
    expect(issuesOf(() => parseScan(scan)).map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "reasoning must not exceed output",
        "cacheWrite5m and cacheWrite1h must not exceed cacheWrite",
        "compacted must not exceed compactions",
        expect.stringMatching(/store name/),
      ]),
    );
    expect(issuesOf(() => parseScan(scan)).map((issue) => issue.path)).toContain(
      "$.usage.sessions[1].thread",
    );
  });

  it("shares a Report without usage, so no project name leaves the user's machines", () => {
    const report = fleet();
    expect(report.usage).toBeDefined();
    const shared = shareableReport(report);
    expect("usage" in shared).toBe(false);
    expect(JSON.stringify(shared)).not.toContain("acme/web");
    expect(report.usage).toBeDefined();
    expect(validators.get("report.v1.json")!(shared)).toBe(true);
  });

  it("shares a Report without any description and leaves the original as it was", () => {
    const report = fleet();
    const shared = shareableReport(report);
    expect(shared.sheet.flatMap((sheet) => sheet.lines).some((line) => "description" in line)).toBe(
      false,
    );
    expect(report.sheet[0]!.lines.some((line) => line.description !== undefined)).toBe(true);
    expect(parseReport(shared)).toEqual(shared);
    expect(validators.get("report.v1.json")!(shared)).toBe(true);
  });

  it("rejects a set fix with nothing to set and a fix without a machine outside pack mode", () => {
    const report = fleet();
    const fix = report.findings.flatMap((finding) => finding.fixes).find((entry) => entry.set)!;
    delete fix.set;
    expect(issuesOf(() => parseReport(report)).map((issue) => issue.message)).toEqual([
      "set and hide-from-model need set or run",
    ]);
    expect(validators.get("report.v1.json")!(report)).toBe(false);

    const other = fleet();
    delete other.findings[0]!.fixes[0]!.machine;
    expect(issuesOf(() => parseReport(other))).toEqual([
      { path: "$.findings", message: "outside pack mode every fix names its machine" },
    ]);
    expect(validators.get("report.v1.json")!(other)).toBe(false);
  });

  it("rejects a timestamp on a day that does not exist", () => {
    const report = fleet();
    report.generatedAt = "2026-02-30T00:00:00Z";
    expect(issuesOf(() => parseReport(report))).toEqual([
      { path: "$.generatedAt", message: "must be a real calendar day" },
    ]);
  });

  it("reads a finding and a skipped rule from a rule it does not know", () => {
    const report = fleet();
    report.findings[0] = { ...report.findings[0]!, id: "stale-hook:skill:x", rule: "stale-hook" };
    report.skipped.push({ rule: "stale-hook", harness: "codex", reason: "not-enough-data" });
    expect(() => parseReport(report)).not.toThrow();
    expect(validators.get("report.v1.json")!(report)).toBe(true);

    report.findings[0] = { ...report.findings[0]!, id: "/root/private:x", rule: "/root/private" };
    expect(issuesOf(() => parseReport(report)).map((issue) => issue.path)).toEqual([
      "$.findings[0].id",
      "$.findings[0].rule",
    ]);
    expect(validators.get("report.v1.json")!(report)).toBe(false);
  });

  it.each(["dead-pack:/Users/ada/skills", "dead-skill:skill:C:\\Users\\ada\\x"])(
    "rejects a home path in the finding id %s",
    (id) => {
      const report = fleet();
      const rule = id.split(":")[0]!;
      report.findings[0] = { ...report.findings[0]!, id, rule };
      expect(validators.get("report.v1.json")!(report)).toBe(false);
      expect(issuesOf(() => parseReport(report)).map((issue) => issue.path)).toEqual([
        "$.findings[0].id",
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

  it("rejects a filter that is not an entrypoint or a harness id", () => {
    expect(
      issuesOf(() =>
        parseConfig({
          via: { include: ["/home/someone/private"], exclude: ["claude-vscode", "a/b"] },
          harnesses: ["claude-code", "Claude Code"],
          ignore: [
            "mcp:@scope/server",
            "skill:/home/someone/private",
            "skill: /home/someone/private",
            "skill:\t/Users/someone/private",
          ],
        }),
      ).map((issue) => issue.path),
    ).toEqual([
      "$.harnesses[1]",
      "$.via.include[0]",
      "$.via.exclude[1]",
      "$.ignore[1]",
      "$.ignore[2]",
      "$.ignore[3]",
    ]);
    expect(() =>
      parseConfig({
        via: { include: ["sdk-ts", "codex_vscode", "Codex Desktop"] },
        ignore: [
          "skill:my skill",
          "skill:team/deploy",
          "instructions:~/.codex/AGENTS.md",
          "instructions:CLAUDE.md",
          "instructions:home/notes.md",
        ],
      }),
    ).not.toThrow();
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

  it("keeps the default of an option set to undefined", () => {
    const resolved = resolveConfig({ rules: { "dead-skill": { minDays: undefined } } });
    expect(resolved.rules["dead-skill"]).toEqual(defaultConfig.rules["dead-skill"]);
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
        `${finding.rule}:${finding.item ?? finding.pack ?? finding.where[0]!.harness}${finding.via ? `:${finding.via}` : ""}`,
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

  const fleetReport = fleet();
  it.each([
    ["machines", (pack: Report) => pack.machines.push(fleetReport.machines[0]!)],
    ["coverage", (pack: Report) => pack.coverage.push(fleetReport.coverage[0]!)],
    ["line machines", (pack: Report) => pack.sheet[0]!.lines[0]!.machines.push("desktop")],
    [
      "where",
      (pack: Report) => pack.findings[0]!.where.push({ machine: "desktop", harness: "codex" }),
    ],
    [
      "fix machine",
      (pack: Report) => Object.assign(pack.findings[0]!.fixes[0]!, { machine: "desktop" }),
    ],
  ] as const)("rejects machine data in %s", (_, addMachine) => {
    const pack = clone(report);
    addMachine(pack);
    expect(validators.get("report.v1.json")!(pack)).toBe(false);
    expect(() => parseReport(pack)).toThrow(SchemaError);
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
