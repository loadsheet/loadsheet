import { spawnSync } from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  CANARY,
  canaryText,
  createSanitizer,
  findCanary,
  findCanaryInDir,
  pathPseudonym,
  sanitize,
  sanitizeJsonl,
  type Policy,
} from "../src/index.ts";

// mulberry32: seeded, so a failing case reproduces.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Values share no character with keys (K + digits), numbers, true/false/null or the canary,
// so any input string found in the output can only have leaked.
const VALUE_CHARS = [
  "b",
  "c",
  "d",
  "g",
  "h",
  "i",
  "j",
  "m",
  "o",
  "p",
  "q",
  "v",
  "w",
  "x",
  "y",
  "z",
  " ",
  "é",
  "日",
  "🙂",
  '"',
  "\\",
  "\n",
  "/",
];

function generateJson(next: () => number, depth = 0): unknown {
  const roll = next();
  const text = () =>
    Array.from(
      { length: Math.floor(next() * 20) },
      () => VALUE_CHARS[Math.floor(next() * VALUE_CHARS.length)]!,
    ).join("");
  if (depth > 3 || roll < 0.4) {
    const leaf = next();
    if (leaf < 0.6) return text();
    if (leaf < 0.75) return Math.floor(next() * 1e6) / 100;
    if (leaf < 0.85) return next() < 0.5;
    return null;
  }
  const size = Math.floor(next() * 5);
  if (roll < 0.7) return Array.from({ length: size }, () => generateJson(next, depth + 1));
  return Object.fromEntries(
    Array.from({ length: size }, (_, index) => [`K${index}`, generateJson(next, depth + 1)]),
  );
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) strings(item, out);
  }
  return out;
}

// Every string blanked and every key dropped: what must survive sanitizing.
function shape(value: unknown): unknown {
  if (typeof value === "string") return "";
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value === "object" && value !== null) {
    return { values: Object.values(value).map(shape) };
  }
  return value;
}

describe("sanitize with an empty policy", () => {
  it.each([1, 2, 3, 4])("no input string of 4+ characters survives, seed %i", (seed) => {
    const next = random(seed);
    for (let round = 0; round < 200; round += 1) {
      const input = generateJson(next);
      const lines = Array.from({ length: 3 }, () => JSON.stringify(generateJson(next)));
      const jsonl = sanitizeJsonl(lines.join("\n") + "\n");
      const output = JSON.stringify(sanitize(input)) + "\n" + jsonl;
      const secrets = [input, ...lines.map((line) => JSON.parse(line) as unknown)]
        .flatMap((value) => strings(value))
        .filter((text) => text.length >= 4);
      for (const secret of secrets) {
        expect(output).not.toContain(secret);
        expect(output).not.toContain(JSON.stringify(secret).slice(1, -1));
      }
    }
  });

  it.each([5, 6])("keeps structure and numbers, seed %i", (seed) => {
    const next = random(seed);
    for (let round = 0; round < 100; round += 1) {
      const input = generateJson(next);
      const output = sanitize(input);
      expect(shape(output)).toEqual(shape(input));
      expect(strings(output).every((text) => text === CANARY)).toBe(true);
      expect(sanitize(input, { keys: ["K0", "K1", "K2", "K3", "K4"] })).toEqual(
        JSON.parse(
          JSON.stringify(input, (_, item: unknown) => (typeof item === "string" ? CANARY : item)),
        ),
      );
    }
  });

  it("keeps the line count, blank lines and CRLF endings of JSONL", () => {
    const input = '{"a":"x"}\r\n\n[1,"y"]\nnot json\n{"b":2}';
    const output = sanitizeJsonl(input);
    expect(output.split("\n")).toEqual([
      `{"key-1":"${CANARY}"}\r`,
      "",
      `[1,"${CANARY}"]`,
      CANARY,
      '{"key-2":2}',
    ]);
  });
});

describe("object keys", () => {
  const input = {
    "0b5e1c7e-6a0f-4f0e-9b1a-2f6f3a1d9c55": { type: "user" },
    env: { CUSTOMER_API_TOKEN: "value", "customer-name.md": "text" },
  };

  it("replaces every key under an empty policy, the same key always with the same name", () => {
    expect(sanitize([input, { env: 1 }])).toEqual([
      { "key-1": { "key-2": CANARY }, "key-3": { "key-4": CANARY, "key-5": CANARY } },
      { "key-3": 1 },
    ]);
  });

  it("keeps the keys the policy lists and the keys its rules name, and matches rules on the original", () => {
    const policy: Policy = { keys: ["env"], rules: { "*.type": "keep", "env.*": "length" } };
    expect(sanitize(input, policy)).toEqual({
      "key-1": { type: "user" },
      env: { "key-2": canaryText(5), "key-3": canaryText(4) },
    });
  });

  it("refuses to keep a key that a generated key could be named", () => {
    expect(() => sanitize({}, { keys: ["key-2"] })).toThrow("key-2");
    expect(() => sanitize({}, { rules: { "a.key-7": "keep" } })).toThrow("key-7");
  });
});

describe("policy actions", () => {
  const line = {
    type: "assistant",
    sessionId: "abc-session",
    message: {
      content: [
        { type: "text", text: "secret prose" },
        { type: "tool_use", name: "Skill", input: { "private key": "value" } },
      ],
    },
    skills: ["deploy", "review", "deploy"],
  };

  it("keeps, pseudonymizes, blanks and replaces subtrees by path pattern", () => {
    const policy: Policy = {
      rules: {
        type: "keep",
        "message.content.*.type": "keep",
        "message.content.*.name": "keep",
        "message.content.*.input": "opaque",
        "message.**.text": "length",
        sessionId: { pseudonym: "session" },
        "skills.*": { pseudonym: "skill" },
      },
    };
    expect(sanitize(line, policy)).toEqual({
      type: "assistant",
      sessionId: "session-1",
      message: {
        content: [
          { type: "text", text: canaryText("secret prose".length) },
          { type: "tool_use", name: "Skill", input: CANARY },
        ],
      },
      skills: ["skill-1", "skill-2", "skill-1"],
    });
  });

  it("the first matching rule wins", () => {
    const policy: Policy = { rules: { "skills.0": "keep", "skills.*": "length" } };
    expect((sanitize(line, policy) as typeof line).skills).toEqual([
      "deploy",
      canaryText(6),
      canaryText(6),
    ]);
  });

  it("pseudonyms are stable across a run and collision-free", () => {
    const sanitizer = createSanitizer({ rules: { "*": { pseudonym: "id" } } });
    const inputs = Array.from({ length: 500 }, (_, index) => `input ${index % 250}`);
    const names = inputs.map((input) => sanitizer.sanitize([input]) as string[]).flat();
    for (let index = 0; index < 250; index += 1) expect(names[index + 250]).toBe(names[index]);
    expect(new Set(names).size).toBe(250);
    const again = createSanitizer({ rules: { "*": { pseudonym: "id" } } });
    expect(again.sanitize([inputs[7]])).toEqual([names[0]]);
  });

  it("keeps different kinds apart", () => {
    const policy: Policy = { rules: { a: { pseudonym: "skill" }, b: { pseudonym: "skill-1" } } };
    const output = sanitize({ a: "x", b: "x" }, policy) as { a: string; b: string };
    expect(output.a).not.toBe(output.b);
  });

  it("length-preserving canary text has the input's length", () => {
    for (const text of [
      "",
      "ab",
      "a".repeat(9),
      "日本語 é 🙂 text that runs long",
      "x".repeat(1000),
    ]) {
      const output = sanitize({ t: text }, { rules: { t: "length" } }) as { t: string };
      expect(output.t).toHaveLength(text.length);
      expect(findCanary(output)).toEqual(text === "" ? [] : ["$.t"]);
    }
  });

  it("a custom function keeps a listing's shape and pseudonymizes its names", () => {
    const listing = "- deploy: Ship the app to prod\n- review: Look at a diff\n";
    const policy: Policy = {
      rules: {
        listing: (value, { pseudonym }) =>
          String(value).replace(
            /^- ([^:]+): (.*)$/gm,
            (_, name: string, description: string) =>
              `- ${pseudonym("skill", name)}: ${canaryText(description.length)}`,
          ),
      },
    };
    const output = sanitize({ listing }, policy) as { listing: string };
    expect(output.listing).toBe(
      `- skill-1: ${canaryText("Ship the app to prod".length)}\n- skill-2: ${canaryText("Look at a diff".length)}\n`,
    );
    expect(output.listing).not.toContain("deploy");
  });

  it("pathPseudonym keeps a path's shape and the names it is told to keep", () => {
    const policy: Policy = { rules: { "*": pathPseudonym({ keep: [".claude", "SKILL.md"] }) } };
    const output = sanitize(
      [
        "/home/someone/work/app/.claude/skills/deploy/SKILL.md",
        "/Users/someone/work/app/notes.txt",
        "relative/notes.txt",
        "relative/dump.customer-internal",
      ],
      policy,
    );
    expect(output).toEqual([
      "~/dir-1/dir-2/.claude/dir-3/dir-4/SKILL.md",
      "~/dir-1/dir-2/file-1.txt",
      "dir-5/file-1.txt",
      "dir-5/file-2",
    ]);
  });

  it("pathPseudonym keeps only the extensions it is given", () => {
    const policy: Policy = { rules: { "*": pathPseudonym({ extensions: [".log"] }) } };
    expect(sanitize(["a/run.log", "a/notes.md"], policy)).toEqual([
      "dir-1/file-1.log",
      "dir-1/file-2",
    ]);
  });
});

describe("findCanary", () => {
  it("finds the canary nested in arrays, objects, keys and inside longer strings", () => {
    const value = {
      a: [1, { b: `before ${CANARY} after` }],
      clean: "nothing here",
      [`key ${CANARY}`]: 3,
      "odd key": [[CANARY]],
    };
    expect(findCanary(value)).toEqual(["$.a[1].b", `$["key ${CANARY}"]`, '$["odd key"][0][0]']);
    expect(findCanary({ clean: "nothing", n: 1 })).toEqual([]);
  });

  it("finds canary text of any length, and any slice of it", () => {
    const output = sanitize(["hello", "x".repeat(40)], { rules: { "*": "length" } });
    expect(findCanary(output)).toEqual(["$[0]", "$[1]"]);
    expect(findCanary({ cut: canaryText(40).slice(17, 19) })).toEqual(["$.cut"]);
  });

  it("catches a deliberately leaky transform", () => {
    const input = { text: "private words from a transcript" };
    const leaky: Policy = { rules: { text: (value) => `summary: ${String(value)}` } };
    expect(findCanary(sanitize(input, leaky), [input.text])).toEqual(["$.text"]);
    expect(findCanary({ text: "clean" }, [input.text])).toEqual([]);
  });
});

describe("findCanaryInDir", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-canary-"));
  });
  afterEach(async () => {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  });

  it("reports the files that hold the canary or a forbidden string, however encoded", async () => {
    await NodeFSP.mkdir(NodePath.join(dir, "nested"));
    await NodeFSP.writeFile(NodePath.join(dir, "clean.json"), '{"count":3}');
    await NodeFSP.writeFile(NodePath.join(dir, "nested", "raw.txt"), `x ${CANARY} y`);
    await NodeFSP.writeFile(
      NodePath.join(dir, "escaped.jsonl"),
      '{"a":1}\n' + JSON.stringify({ t: 'say "hi"\n' }) + "\n",
    );
    await NodeFSP.writeFile(NodePath.join(dir, "unicode.jsonl"), '{"t":"\\u0073ecret"}\n');
    await NodeFSP.writeFile(NodePath.join(dir, "indented.json"), '{\n  "t": "\\u0073ecret"\n}\n');
    await NodeFSP.writeFile(NodePath.join(dir, "short.json"), JSON.stringify({ t: canaryText(2) }));
    expect(await findCanaryInDir(dir)).toEqual([NodePath.join("nested", "raw.txt"), "short.json"]);
    expect(await findCanaryInDir(dir, ['say "hi"\n', "secret"])).toEqual([
      "escaped.jsonl",
      "indented.json",
      NodePath.join("nested", "raw.txt"),
      "short.json",
      "unicode.jsonl",
    ]);
  });
});

describe("sanitize script", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-sanitize-"));
  });
  afterEach(async () => {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  });

  it("sanitizes a JSONL file with a policy module", async () => {
    const script = fileURLToPath(new URL("../scripts/sanitize.ts", import.meta.url));
    await NodeFSP.writeFile(
      NodePath.join(dir, "in.jsonl"),
      '{"type":"user","text":"private"}\n{"type":"assistant","text":"more private"}\n',
    );
    await NodeFSP.writeFile(
      NodePath.join(dir, "policy.mjs"),
      'export default { rules: { type: "keep", text: "length" } };\n',
    );
    const result = spawnSync(
      process.execPath,
      [script, "in.jsonl", "out/out.jsonl", "--policy", "policy.mjs"],
      { encoding: "utf8", env: { ...process.env, INIT_CWD: dir } },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2 lines written");
    const output = await NodeFSP.readFile(NodePath.join(dir, "out", "out.jsonl"), "utf8");
    expect(output).toBe(
      `{"type":"user","text":"${canaryText(7)}"}\n{"type":"assistant","text":"${canaryText(12)}"}\n`,
    );
  });
});
