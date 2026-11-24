import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { memoryFiles, sha256 } from "../src/index.ts";
import { dirFiles } from "../src/node/index.ts";

describe("memoryFiles", () => {
  it("lists paths sorted and reads text", async () => {
    const files = memoryFiles({ "b.md": "B", "a/x.md": "X" }, "owner/repo");
    expect(files.name).toBe("owner/repo");
    expect(files.paths).toEqual(["a/x.md", "b.md"]);
    expect(await files.text("b.md")).toBe("B");
    expect(await files.text("missing.md")).toBeUndefined();
  });
});

describe("sha256", () => {
  it("hashes UTF-8 text as lowercase hex", async () => {
    expect(await sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("dirFiles", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "loadsheet-kit-"));
    await mkdir(join(dir, "skills/a"), { recursive: true });
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "node_modules/pkg"), { recursive: true });
    await writeFile(join(dir, "skills/a/SKILL.md"), "---\nname: a\n---\nbody");
    await writeFile(join(dir, "big.md"), "x".repeat(2048));
    await writeFile(join(dir, ".git/HEAD"), "ref");
    await writeFile(join(dir, "node_modules/pkg/SKILL.md"), "no");
    await symlink(join(dir, "skills"), join(dir, "linked"));
    await symlink(dir, join(dir, "skills/a/loop"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("lists files under the directory, skipping .git and node_modules and following symlinks without looping", async () => {
    const files = await dirFiles(dir);
    expect(files.name).toBe(basename(dir));
    expect(files.paths).toEqual(["big.md", "linked/a/SKILL.md", "skills/a/SKILL.md"]);
  });

  it("reads text lazily and returns undefined above the size cap or outside the set", async () => {
    const files = await dirFiles(dir, { maxBytes: 1024 });
    expect(await files.text("skills/a/SKILL.md")).toBe("---\nname: a\n---\nbody");
    expect(await files.text("big.md")).toBeUndefined();
    expect(await files.text(".git/HEAD")).toBeUndefined();
  });

  it("throws on a missing directory", async () => {
    await expect(dirFiles(join(dir, "nope"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
