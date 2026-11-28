import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createProjectResolver, orgOf, repoOfRemote, type ProjectFs } from "../src/node/index.ts";

const remotes = (entries: Record<string, string>) =>
  Object.entries(entries)
    .map(
      ([name, url]) =>
        `[remote "${name}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${name}/*\n`,
    )
    .join("");

const readable = (path: string) => {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

describe("repoOfRemote", () => {
  it.each([
    ["https://github.com/Onmax/Loadsheet.git", "onmax/loadsheet"],
    ["https://github.com/o/r", "o/r"],
    ["https://user:token@github.com/o/r.git/", "o/r"],
    ["https://user:token@github.com/o/r.git?token=secret#other/repo", "o/r"],
    ["git@github.com:o/r.git", "o/r"],
    ["ssh://git@gitlab.example.com:2222/o/r.git", "o/r"],
    ["git://host/o/r", "o/r"],
    ["https://gitlab.com/group/sub/r.git", "sub/r"],
  ])("reads %s as %s", (url, repo) => {
    expect(repoOfRemote(url)).toBe(repo);
  });

  it.each([
    "/srv/git/r.git",
    "../r",
    "file:///home/me/r.git",
    "host:/home/me/r.git",
    "https://github.com/o",
    "git@host:invalid_owner/r.git",
  ])("reads no repository from %s", (url) => {
    expect(repoOfRemote(url)).toBeUndefined();
  });
});

describe("createProjectResolver", () => {
  let home: string;
  let outside: string;
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "loadsheet-projects-home-"));
    outside = mkdtempSync(join(tmpdir(), "loadsheet-projects-out-"));
    // The home is a dotfiles repository; nothing under it may resolve to it.
    write(join(home, ".git/config"), remotes({ origin: "git@github.com:me/dotfiles.git" }));
    write(
      join(home, "code/plain/.git/config"),
      remotes({ origin: "https://github.com/Acme/Plain.git" }),
    );
    mkdirSync(join(home, "code/plain/packages/kit/src"), { recursive: true });
    write(
      join(home, "code/ssh/.git/config"),
      `[core]\n\tbare = false\n${remotes({ upstream: "git@github.com:up/stream.git", origin: "git@github.com:acme/ssh.git" })}`,
    );
    write(
      join(home, "code/fork/.git/config"),
      remotes({ upstream: "https://github.com/up/fork.git" }),
    );
    write(join(home, "code/none/.git/config"), "[core]\n\tbare = false\n");
    mkdirSync(join(home, "code/none/sub"), { recursive: true });
    write(join(home, "code/local/.git/config"), remotes({ origin: join(home, "bare/local.git") }));
    // A worktree: `.git` is a file naming its gitdir, whose commondir leads to the common config.
    write(join(home, "code/main/.git/config"), remotes({ origin: "https://github.com/acme/main" }));
    write(join(home, "code/main/.git/worktrees/feat/commondir"), "../..\n");
    write(
      join(home, ".t3/worktrees/main/feat/.git"),
      `gitdir: ${join(home, "code/main/.git/worktrees/feat")}\n`,
    );
    // A submodule: relative gitdir, config in the gitdir itself.
    write(
      join(home, "code/main/.git/modules/sub/config"),
      remotes({ origin: "git@github.com:acme/sub.git" }),
    );
    write(join(home, "code/main/sub/.git"), "gitdir: ../.git/modules/sub\n");
    write(
      join(outside, "repo/.git/config"),
      remotes({ origin: "https://github.com/far/away.git" }),
    );
    mkdirSync(join(outside, "plain"), { recursive: true });
    mkdirSync(join(home, ".t3/worktrees/kept"), { recursive: true });
    // Flat T3 worktrees, `<repo>-<branch>`: two of acme/portal, one of a repository named
    // portal-kit, one whose remote is not named after its folder, and two owners of twin.
    for (const [name, url] of Object.entries({
      "portal-live-a": "https://github.com/acme/portal",
      "portal-live-b": "git@github.com:acme/portal.git",
      "portal-kit-live": "https://github.com/acme/portal-kit",
      "pad-live": "https://github.com/acme/other",
      "twin-a": "https://github.com/one/twin",
      "twin-b": "https://github.com/two/twin",
    }))
      write(join(home, ".t3/worktrees", name, ".git/config"), remotes({ origin: url }));
    // A config with a section per branch, past 64 KiB.
    const branches = Array.from(
      { length: 3000 },
      (_, i) => `[branch "b${i}"]\n\tremote = origin\n`,
    );
    write(
      join(home, "code/big/.git/config"),
      `${remotes({ origin: "https://github.com/acme/big.git" })}${branches.join("")}`,
    );
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const resolver = (hints: { prefix: string; project: string }[] = []) =>
    createProjectResolver({ home, hints });

  it("reads origin from a plain repository, lowercased", () => {
    expect(resolver()("~/code/plain")).toBe("acme/plain");
  });

  it("reads the repository of a nested folder", () => {
    expect(resolver()("~/code/plain/packages/kit/src")).toBe("acme/plain");
  });

  it("prefers origin over the remote listed first", () => {
    expect(resolver()("~/code/ssh")).toBe("acme/ssh");
  });

  it("falls back to the first remote when there is no origin", () => {
    expect(resolver()("~/code/fork")).toBe("up/fork");
  });

  it("follows a worktree's .git file to the common config", () => {
    expect(resolver()("~/.t3/worktrees/main/feat")).toBe("acme/main");
  });

  it("follows a submodule's relative gitdir", () => {
    expect(resolver()("~/code/main/sub")).toBe("acme/sub");
  });

  it("reads absolute paths outside the home", () => {
    expect(resolver()(join(outside, "repo"))).toBe("far/away");
    // The temporary folder holding `outside` folds to its parent; anywhere else the path stays.
    const plain = join(outside, "plain");
    expect(resolver()(plain)).toBe(plain.startsWith("/tmp/") ? "/tmp" : plain);
  });

  it("turns an absolute path under the home into a key", () => {
    expect(resolver()(join(home, "code/plain"))).toBe("acme/plain");
    expect(resolver()(join(home, "notes"))).toBe("~/notes");
  });

  it("keeps the key of a repository with no remote, or only a remote on the disk", () => {
    expect(resolver()("~/code/none/sub")).toBe("~/code/none/sub");
    expect(resolver()("~/code/local")).toBe("~/code/local");
  });

  it("never reads the home's own repository", () => {
    expect(resolver()("~")).toBe("~");
    expect(resolver()("~/notes/today")).toBe("~/notes/today");
  });

  it("resolves a deleted worktree through the longest hint", () => {
    const resolve = resolver([
      { prefix: "~/.t3/worktrees/gone", project: "acme/short" },
      { prefix: "~/.t3/worktrees/gone/feat-x", project: "Acme/Long" },
      { prefix: join(home, "old"), project: "acme/old" },
    ]);
    expect(resolve("~/.t3/worktrees/gone/feat-x/packages")).toBe("acme/long");
    expect(resolve("~/.t3/worktrees/gone/feat-y")).toBe("acme/short");
    expect(resolve("~/.t3/worktrees/gone-too/feat")).toBe("~/.t3/worktrees");
    expect(resolve("~/old/thing")).toBe("acme/old");
  });

  it("prefers the git remote over a hint", () => {
    expect(resolver([{ prefix: "~/code/plain", project: "x/y" }])("~/code/plain")).toBe(
      "acme/plain",
    );
  });

  it("folds worktree folders to their repository", () => {
    const resolve = resolver();
    // The repository's folder is still there, so it names the project.
    expect(resolve("~/.t3/worktrees/kept/feat-gone/packages/kit")).toBe("~/.t3/worktrees/kept");
    expect(resolve("~/work/app/.claude/worktrees/agent-1/src")).toBe("~/work/app");
  });

  it("reads a config larger than 64 KiB", () => {
    expect(resolver()("~/code/big/src")).toBe("acme/big");
  });

  it("names a deleted T3 worktree by a live worktree beside it", () => {
    expect(resolver()("~/.t3/worktrees/main/feat-gone/src")).toBe("acme/main");
  });

  it("names a deleted flat T3 worktree by a live worktree of the same repository", () => {
    const resolve = resolver();
    expect(resolve("~/.t3/worktrees/portal-date-picker-gone/src")).toBe("acme/portal");
    expect(resolve("~/.t3/worktrees/portal-kit-gone")).toBe("acme/portal-kit");
    expect(resolve("~/.t3/worktrees/portal")).toBe("acme/portal");
  });

  it("folds a deleted T3 worktree no live worktree names to one key", () => {
    const resolve = resolver();
    // pad-live's remote is acme/other, so it says nothing of a repository named pad.
    expect(resolve("~/.t3/worktrees/pad-gone")).toBe("~/.t3/worktrees");
    // Two owners of twin, one worktree each: neither decides.
    expect(resolve("~/.t3/worktrees/twin-gone/src")).toBe("~/.t3/worktrees");
    expect(resolve("~/.t3/worktrees/t3-1a2b3c4d")).toBe("~/.t3/worktrees");
  });

  it("folds scratch and temporary folders to their parent", () => {
    const resolve = resolver();
    expect(resolve("~/.t3/scratch/2026-11-25-a-task-title-1234/src")).toBe("~/.t3/scratch");
    expect(resolve("/tmp/probe")).toBe("/tmp");
  });

  it("passes an owner/repo key through", () => {
    expect(resolver()("Acme/Repo")).toBe("acme/repo");
  });

  it("never names the home's absolute path", () => {
    const resolve = resolver();
    const keys = [
      "~",
      "~/code/none",
      "~/code/local",
      "~/gone",
      home,
      join(home, "code/none"),
      join(home, "x/y"),
    ];
    for (const key of keys) expect(resolve(key)).not.toContain(home);
  });

  it("reads the disk once per key", () => {
    let reads = 0;
    const fs: ProjectFs = {
      kind: (path) => (reads++, path === "/h/repo/.git" ? "dir" : undefined),
      read: () => (reads++, remotes({ origin: "git@github.com:acme/repo.git" })),
    };
    const resolve = createProjectResolver({ home: "/h", fs });
    expect(resolve("~/repo/src")).toBe("acme/repo");
    const first = reads;
    expect(resolve("~/repo/src")).toBe("acme/repo");
    expect(reads).toBe(first);
  });

  it("moves on when the git config cannot be read", () => {
    const config = join(home, "code/locked/.git/config");
    write(config, remotes({ origin: "https://github.com/acme/locked" }));
    chmodSync(config, 0o000);
    try {
      expect(resolver()("~/code/locked")).toBe(readable(config) ? "acme/locked" : "~/code/locked");
    } finally {
      chmodSync(config, 0o644);
    }
  });

  it("stops walking after twelve levels", () => {
    const deep = `/${Array.from({ length: 20 }, (_, i) => `d${i}`).join("/")}`;
    const seen: string[] = [];
    const resolve = createProjectResolver({
      home: "/h",
      fs: { kind: (path) => (seen.push(path), undefined), read: () => undefined },
    });
    expect(resolve(deep)).toBe(deep);
    expect(seen).toHaveLength(12);
  });
});

describe("orgOf", () => {
  it.each([
    ["acme/repo", "acme"],
    ["~/code/app", "~/code"],
    ["~/notes", "~/notes"],
    ["~", "~"],
    ["/srv/app/x", "/srv"],
  ])("%s belongs to %s", (project, org) => {
    expect(orgOf(project)).toBe(org);
  });
});
