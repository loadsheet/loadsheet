import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { githubFiles, parseGithubUrl, readTar } from "../src/node/index.ts";

const encoder = new TextEncoder();

// A tar header: name, mode, uid, gid, size, mtime, checksum, type, then ustar magic and prefix.
const header = (name: string, size: number, type: string, prefix = "") => {
  const block = new Uint8Array(512);
  const put = (text: string, offset: number) => block.set(encoder.encode(text), offset);
  put(name, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put(type, 156);
  put("ustar\0", 257);
  put("00", 263);
  put(prefix, 345);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
};

const padded = (bytes: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  out.set(bytes);
  return out;
};

type Entry = { name: string; text?: string; type?: string; prefix?: string };

const tar = (entries: Entry[]) => {
  const blocks: Uint8Array[] = [];
  for (const { name, text = "", type = "0", prefix } of entries) {
    const data = encoder.encode(text);
    blocks.push(header(name, data.length, type, prefix), padded(data));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
};

const paxRecord = (key: string, value: string) => {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length++;
  return `${length}${body}`;
};

const longName = `repo-sha/skills/${"deep/".repeat(30)}SKILL.md`;

const archive = tar([
  { name: "pax_global_header", type: "g", text: paxRecord("comment", "sha") },
  { name: "repo-sha/", type: "5" },
  { name: "repo-sha/README.md", text: "# Readme\n" },
  { name: "SKILL.md", prefix: "repo-sha/skills/a", text: "---\nname: a\n---\nbody é\n" },
  { name: "PaxHeader", type: "x", text: paxRecord("path", longName) },
  { name: "truncated-name", text: "deep" },
  { name: "repo-sha/link", type: "2" },
  { name: "repo-sha/node_modules/x/SKILL.md", text: "skip" },
]);

describe("readTar", () => {
  it("reads regular files with ustar prefixes and pax paths, and skips the rest", () => {
    const files = readTar(archive);
    expect([...files.keys()]).toEqual([
      "repo-sha/README.md",
      "repo-sha/skills/a/SKILL.md",
      longName,
      "repo-sha/node_modules/x/SKILL.md",
    ]);
    expect(new TextDecoder().decode(files.get("repo-sha/skills/a/SKILL.md"))).toBe(
      "---\nname: a\n---\nbody é\n",
    );
    expect(new TextDecoder().decode(files.get(longName))).toBe("deep");
  });

  it("reads a GNU long name", () => {
    const name = `${"x".repeat(150)}.md`;
    const files = readTar(
      tar([
        { name: "././@LongLink", type: "L", text: `${name}\0` },
        { name: "short", text: "1" },
      ]),
    );
    expect([...files.keys()]).toEqual([name]);
  });
});

describe("parseGithubUrl", () => {
  it.each([
    ["https://github.com/o/r", { owner: "o", repo: "r" }],
    ["https://github.com/o/r.git", { owner: "o", repo: "r" }],
    ["https://github.com/o/r/tree/main", { owner: "o", repo: "r", ref: "main" }],
    [
      "https://github.com/o/r/tree/abc123/harness/pack/",
      { owner: "o", repo: "r", ref: "abc123", subdir: "harness/pack" },
    ],
  ])("%s", (url, expected) => {
    expect(parseGithubUrl(url)).toEqual(expected);
  });

  it.each([
    ["https://gitlab.com/o/r", /Only github.com/],
    ["https://github.com/o", /Not a GitHub repository URL/],
    ["https://github.com/o/r/blob/main/x", /Not a GitHub repository URL/],
    ["github.com/o/r", /Not a URL/],
  ])("rejects %s", (url, message) => {
    expect(() => parseGithubUrl(url)).toThrow(message);
  });
});

describe("githubFiles", () => {
  const serve = (status: number, body?: Uint8Array) => {
    const requests: string[] = [];
    const get = (async (url: string) => {
      requests.push(url);
      return new Response(body, { status });
    }) as typeof fetch;
    return { get, requests };
  };

  it("downloads the default branch and strips codeload's top folder", async () => {
    const { get, requests } = serve(200, gzipSync(archive));
    const files = await githubFiles("https://github.com/o/r", { fetch: get });
    expect(requests).toEqual(["https://codeload.github.com/o/r/tar.gz/HEAD"]);
    expect(files.name).toBe("o/r");
    expect(files.paths).toEqual([
      "README.md",
      "skills/a/SKILL.md",
      longName.slice("repo-sha/".length),
    ]);
    expect(await files.text("skills/a/SKILL.md")).toBe("---\nname: a\n---\nbody é\n");
  });

  it("narrows to a folder at a ref", async () => {
    const { get, requests } = serve(200, gzipSync(archive));
    const files = await githubFiles("https://github.com/o/r/tree/v1/skills/a", { fetch: get });
    expect(requests).toEqual(["https://codeload.github.com/o/r/tar.gz/v1"]);
    expect(files.paths).toEqual(["SKILL.md"]);
  });

  it("says when the folder is not there", async () => {
    const { get } = serve(200, gzipSync(archive));
    await expect(
      githubFiles("https://github.com/o/r/tree/v1/nope", { fetch: get }),
    ).rejects.toThrow("o/r@v1 has no folder nope");
  });

  it("explains a 404 for a repository and for a ref", async () => {
    await expect(githubFiles("https://github.com/o/r", { fetch: serve(404).get })).rejects.toThrow(
      "GitHub repository o/r not found, or it is private",
    );
    await expect(
      githubFiles("https://github.com/o/r/tree/x", { fetch: serve(404).get }),
    ).rejects.toThrow("GitHub has no ref x in o/r");
  });
});
