import { readdirSync, readFileSync } from "node:fs";
import type { Fix } from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const doc = read("../../../docs/agent-prompt.md");
const prompt = /```text\n([\s\S]*?)```/u.exec(doc)?.[1] ?? "";

// Typed so that an action added to or taken from the schema's Fix fails the typecheck here.
const ACTIONS: Record<Fix["action"], true> = {
  remove: true,
  "hide-from-model": true,
  shorten: true,
  dedupe: true,
  set: true,
};

/**
 * The family of every `set` key core can emit, read from its source: a literal key whole, a
 * template key up to its first `${`, such as `skillOverrides.` or `skills.config[path="`.
 */
const keyFamilies = () => {
  const core = new URL("../../core/src/", import.meta.url);
  const sources = [
    read(new URL("fixes.ts", core).href),
    ...readdirSync(new URL("rules/", core)).map((file) =>
      read(new URL(`rules/${file}`, core).href),
    ),
  ];
  const families = new Set<string>();
  for (const source of sources) {
    for (const [, , key] of source.matchAll(/\bkey: (["`])(.+?)\1/gu)) {
      families.add(key!.split("${")[0]!);
    }
  }
  return [...families];
};

describe("docs/agent-prompt.md", () => {
  it("is linked from the README", () => {
    expect(read("../../../README.md")).toContain("docs/agent-prompt.md");
  });

  it("holds a prompt short enough to paste", () => {
    expect(prompt).toContain("npx loadsheet --json");
    expect(prompt.split("\n").length).toBeLessThanOrEqual(60);
  });

  it("names every action a Fix can have", () => {
    for (const action of Object.keys(ACTIONS)) expect(prompt).toContain(`\`${action}\``);
  });

  it("names every set key family the code emits", () => {
    const families = keyFamilies();
    expect(families.length).toBeGreaterThan(3);
    for (const family of families) expect(prompt).toContain(family);
  });
});
