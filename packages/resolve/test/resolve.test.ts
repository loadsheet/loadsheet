import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseReport } from "@loadsheet/schema";
import { resolveSource } from "skills";
import { create } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { parsePackSource, ResolveError, resolvePack } from "../src/index.ts";

const fixtureDir = join(import.meta.dirname, "fixtures", "pack");
const SKILLS_CONFIG = { telemetry: false } as const;

/** A folder as codeload serves it: gzipped, everything under one `<repo>-<sha>/` folder. */
const tarball = (dir: string): Uint8Array => {
  const out = mkdtempSync(join(tmpdir(), "loadsheet-resolve-test-"));
  try {
    const file = join(out, "pack.tgz");
    const paths = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));
    create(
      { gzip: true, sync: true, portable: true, file, cwd: dir, prefix: "pack-0123abc" },
      paths,
    );
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};

/** A fetch that serves one body for every request and records what was asked for. */
const serve = (body: Uint8Array | undefined, status = 200) => {
  const requests: string[] = [];
  const get = (async (url: string) => {
    requests.push(String(url));
    return new Response(body?.slice(), { status });
  }) as typeof fetch;
  return { get, requests };
};

const skillNames = (report: { sheet: { lines: { ref: { kind: string; name: string } }[] }[] }) =>
  report.sheet
    .flatMap((sheet) => sheet.lines)
    .filter((line) => line.ref.kind === "skill")
    .map((line) => line.ref.name)
    .sort();

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ResolveError) return error.code;
    throw error;
  }
  throw new Error("expected a ResolveError");
};

// Any request that does not go through the injected fetch, such as telemetry to skills.sh, lands here.
let globalRequests: string[];
beforeEach(() => {
  globalRequests = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    globalRequests.push(String(url instanceof Request ? url.url : url));
    throw new Error("network is off in this test");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolvePack", () => {
  const archive = tarball(fixtureDir);
  const now = new Date("2026-11-25T12:00:00Z");

  it("weighs a GitHub tarball as a pack Report that parseReport accepts", async () => {
    const { get, requests } = serve(archive);
    const report = await resolvePack("acme/pack", { fetch: get, now, tool: "loadsheet@test" });

    expect(parseReport(report)).toEqual(report);
    expect(report).toMatchObject({
      mode: "pack",
      source: "https://github.com/acme/pack",
      tool: "loadsheet@test",
      generatedAt: now.toISOString(),
    });
    expect(requests).toEqual(["https://codeload.github.com/acme/pack/tar.gz/HEAD"]);
    const lines = report.sheet[0]!.lines;
    expect(new Set(lines.map((line) => line.path))).toEqual(
      new Set(["skills/alpha", "skills/beta"]),
    );
    for (const line of lines) {
      expect(line.description).toMatch(/^Use when/u);
      expect(line.tokens.value).toBeGreaterThan(0);
      expect(line.pack).toBe("acme/pack");
    }
  });

  it("finds the skills resolveSource finds in the same folder", async () => {
    const expected = await resolveSource(fixtureDir, { config: SKILLS_CONFIG });
    await expected.dispose();
    const report = await resolvePack("https://github.com/acme/pack", { fetch: serve(archive).get });

    // The nested skill, the internal one and the one with no description are not installed.
    expect(skillNames(report)).toEqual(expected.skills.map((skill) => skill.name).sort());
    expect(skillNames(report)).toEqual(["alpha", "beta"]);
  });

  it("lists internal skills when one is asked for by name, as skills add does", async () => {
    const expected = await resolveSource(fixtureDir, {
      config: { ...SKILLS_CONFIG, includeInternal: true },
    });
    await expected.dispose();
    const report = await resolvePack("acme/pack@hidden", { fetch: serve(archive).get });
    expect(skillNames(report)).toEqual(expected.skills.map((skill) => skill.name).sort());
    expect(skillNames(report)).toContain("hidden");
  });

  it("reads a folder at a ref", async () => {
    const { get, requests } = serve(archive);
    const report = await resolvePack("https://github.com/acme/pack/tree/v1.2.0/skills/beta", {
      fetch: get,
    });
    expect(requests).toEqual(["https://codeload.github.com/acme/pack/tar.gz/v1.2.0"]);
    expect(report.source).toBe("https://github.com/acme/pack/tree/v1.2.0/skills/beta");
    // A SKILL.md at the folder's root is the one skill, as in skills add.
    expect(skillNames(report)).toEqual(["beta"]);
    expect(report.sheet[0]!.lines[0]!.path).toBe("SKILL.md");
  });

  it("sends nothing to skills.sh or anywhere but the injected fetch", async () => {
    const { get, requests } = serve(archive);
    await resolvePack("acme/pack", { fetch: get });
    expect(requests.every((url) => url.startsWith("https://codeload.github.com/"))).toBe(true);
    expect(globalRequests).toEqual([]);
  });

  it.each([
    "/etc",
    "./skills",
    "../skills",
    ".",
    "~/skills",
    "C:\\skills",
    "file:///etc/passwd",
    "file:skills",
    "ssh://git@github.com/acme/pack.git",
    "git@github.com:acme/pack.git",
    "https://gitlab.com/acme/pack",
    "https://example.com/.well-known/skills",
    "https://github.com/acme/pack/tree/main/../../etc",
    "acme/pack/../../etc",
    "acme",
    "",
  ])("rejects %j before any fetch", async (input) => {
    const { get, requests } = serve(archive);
    expect(await codeOf(resolvePack(input, { fetch: get }))).toBe("unsupported-source");
    expect(requests).toEqual([]);
    expect(globalRequests).toEqual([]);
  });

  it("stops at maxBytes", async () => {
    expect(
      await codeOf(resolvePack("acme/pack", { fetch: serve(archive).get, maxBytes: 100 })),
    ).toBe("too-large");
    // A small gzip that unpacks past the limit.
    const bomb = gzipSync(new Uint8Array(4 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(
      await codeOf(resolvePack("acme/pack", { fetch: serve(bomb).get, maxBytes: 1024 * 1024 })),
    ).toBe("too-large");
  });

  it("says not-found for a missing repository, ref or folder", async () => {
    expect(await codeOf(resolvePack("acme/missing", { fetch: serve(undefined, 404).get }))).toBe(
      "not-found",
    );
    expect(
      await codeOf(resolvePack("acme/pack/no-such-folder", { fetch: serve(archive).get })),
    ).toBe("not-found");
  });

  it("says no-skills for a repository without any", async () => {
    // Its one SKILL.md has no description, so skills skips it.
    const broken = tarball(join(fixtureDir, "broken"));
    expect(await codeOf(resolvePack("acme/broken", { fetch: serve(broken).get }))).toBe(
      "no-skills",
    );
  });

  it("says timeout when the signal aborts", async () => {
    const controller = new AbortController();
    const get = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        controller.abort(new DOMException("timed out", "TimeoutError"));
      })) as typeof fetch;
    expect(await codeOf(resolvePack("acme/pack", { fetch: get, signal: controller.signal }))).toBe(
      "timeout",
    );
  });
});

describe("parsePackSource", () => {
  it.each([
    ["acme/pack", { owner: "acme", repo: "pack" }],
    ["acme/pack.git", { owner: "acme", repo: "pack" }],
    ["acme/pack/skills/beta", { owner: "acme", repo: "pack", subpath: "skills/beta" }],
    ["acme/pack@v1.2.0", { owner: "acme", repo: "pack", ref: "v1.2.0" }],
    [
      "acme/pack@0123456789abcdef0123456789abcdef01234567",
      { owner: "acme", repo: "pack", ref: "0123456789abcdef0123456789abcdef01234567" },
    ],
    ["acme/pack@beta", { owner: "acme", repo: "pack", skill: "beta" }],
    ["acme/pack#main", { owner: "acme", repo: "pack", ref: "main" }],
    ["acme/pack#main@beta", { owner: "acme", repo: "pack", ref: "main", skill: "beta" }],
    ["github:acme/pack", { owner: "acme", repo: "pack" }],
    ["vercel-labs/vercel-skills", { owner: "vercel-labs", repo: "agent-skills" }],
    ["https://github.com/acme/pack", { owner: "acme", repo: "pack" }],
    ["github.com/acme/pack", { owner: "acme", repo: "pack" }],
    ["https://www.github.com/acme/pack.git#dev", { owner: "acme", repo: "pack", ref: "dev" }],
    ["https://github.com/acme/pack/tree/main", { owner: "acme", repo: "pack", ref: "main" }],
    [
      "https://github.com/acme/pack/tree/main/skills/a%20b/",
      { owner: "acme", repo: "pack", ref: "main", subpath: "skills/a b" },
    ],
    // As in skills, anything after owner/repo other than tree/ names the repository.
    ["https://github.com/acme/pack/blob/main/README.md", { owner: "acme", repo: "pack" }],
  ])("%s", (input, expected) => {
    expect(parsePackSource(input)).toEqual(expected);
  });
});
