/**
  Measures the skill packs on loadsheet.dev/skills and writes what the pages read:

  - `app/skills/packs.json`: each pack at a pinned commit, its skills as `resolvePack` weighs them for Claude Code, the
    rules' findings, and its stars and last push from GitHub.
  - `app/skills/files/<owner>_<repo>[_<dir>].json`: every file in the pack's skill folders, with its size, so the pack
    page can list them. The page fetches a file's text from GitHub at the pinned commit; nothing of the pack is copied
    into this repository.

  Run it from the repository root with `node apps/site/scripts/skill-packs.ts`. GITHUB_TOKEN, when set, lifts GitHub's
  limit of 60 API requests an hour. A pack's prose in `app/skills/copy.json` quotes these numbers, so after a run that
  changes them, have its text rewritten.
*/
import { mkdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolvePack } from "@loadsheet/resolve";
import { readTar } from "@loadsheet/kit/node";

/**
  The packs and the jobs each one is compared on. A pack is read at its default branch's head, or at `ref` when its
  prose describes an older commit.
*/
const PACKS: { source: string; title: string; by: string; jobs: string[]; ref?: string }[] = [
  { source: "anthropics/skills", title: "Anthropic's skills", by: "Anthropic", jobs: ["ui"] },
  {
    source: "obra/superpowers",
    title: "Superpowers",
    by: "Jesse Vincent (obra)",
    jobs: ["workflow"],
  },
  {
    source: "mattpocock/skills",
    title: "Matt Pocock's skills",
    by: "Matt Pocock",
    jobs: ["workflow"],
  },
  {
    source: "cursor/plugins/pstack",
    title: "pstack",
    by: "Lauren Tan (poteto), Cursor",
    jobs: ["workflow"],
  },
  {
    source: "vercel-labs/agent-skills",
    title: "Vercel agent skills",
    by: "Vercel",
    jobs: ["ui", "framework"],
  },
  { source: "antfu/skills", title: "Anthony Fu's skills", by: "Anthony Fu", jobs: ["framework"] },
  // filming-software landed after this pack's copy was written.
  { source: "ibelick/ui-skills", title: "UI Skills", by: "ibelick", jobs: ["ui"], ref: "4b5bf7b" },
  { source: "humanlayer/skills", title: "HumanLayer skills", by: "HumanLayer", jobs: ["workflow"] },
];
/** Packs on the list that the resolver can't read, and why. */
const UNMEASURED = [
  { slug: "affaan-m/everything-claude-code", why: "larger than the 32 MB the resolver reads" },
];
/** The resolver's limit on loadsheet.dev, so a pack measured here can be weighed there too. */
const MAX_BYTES = 32 * 1024 * 1024;

const out = new URL("../app/skills/", import.meta.url);
const headers: Record<string, string> = { accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function github<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);
  return (await res.json()) as T;
}

// A file whose first 8 KB hold a NUL byte is shown as binary.
const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8192).includes(0);

const packs = [];
mkdirSync(new URL("files/", out), { recursive: true });
for (const { source, title, by, jobs, ref } of PACKS) {
  const [owner, name, ...rest] = source.split("/");
  const repo = `${owner}/${name}`;
  const dir = rest.join("/") || undefined;
  const meta = await github<{
    stargazers_count: number;
    pushed_at: string;
    default_branch: string;
  }>(`repos/${repo}`);
  const { sha } = await github<{ sha: string }>(
    `repos/${repo}/commits/${ref ?? meta.default_branch}`,
  );

  // The tarball resolvePack downloads, kept to list the files it held.
  let tarball: Uint8Array | undefined;
  const keep: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (!res.ok) return res;
    tarball = new Uint8Array(await res.arrayBuffer());
    return new Response(tarball, { status: res.status, headers: res.headers });
  };
  const url = `https://github.com/${repo}/tree/${sha}${dir ? `/${dir}` : ""}`;
  const report = await resolvePack(url, { fetch: keep, maxBytes: MAX_BYTES });
  const lines = report.sheet[0]!.lines;
  const items = lines
    .map((l) => ({
      name: l.ref.name,
      path: l.path!,
      tokens: l.tokens.value,
      listed: l.chars?.listed ?? 0,
      body: l.chars?.body ?? 0,
      description: l.description ?? "",
    }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  const findings = report.findings.map((f) => ({
    rule: f.rule,
    item: f.item,
    evidence: f.evidence,
  }));

  // codeload puts everything under one `<repo>-<sha>/` folder; skill paths are relative to the pack's own folder.
  const prefix = dir ? `${dir}/` : "";
  const roots = items.map((i) => (i.path === "SKILL.md" ? "" : `${i.path}/`));
  const files: { path: string; size: number; binary?: true }[] = [];
  for (const [path, bytes] of readTar(gunzipSync(tarball!))) {
    const inRepo = path.slice(path.indexOf("/") + 1);
    if (!inRepo.startsWith(prefix)) continue;
    const rel = inRepo.slice(prefix.length);
    if (!rel || !roots.some((r) => rel.startsWith(r))) continue;
    files.push({
      path: rel,
      size: bytes.length,
      ...(isBinary(bytes) ? { binary: true as const } : {}),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(
    new URL(`files/${source.replaceAll("/", "_")}.json`, out),
    `${JSON.stringify({ source, sha, files })}\n`,
  );

  packs.push({
    slug: source,
    title,
    by,
    repo,
    ...(dir ? { dir } : {}),
    sha,
    stars: meta.stargazers_count,
    pushed: meta.pushed_at.slice(0, 10),
    jobs,
    items,
    findings,
  });
  console.log(
    `${source}@${sha.slice(0, 7)}: ${items.reduce((n, i) => n + i.tokens, 0)} tokens, ${items.length} skills, ${files.length} files`,
  );
}

writeFileSync(
  new URL("packs.json", out),
  `${JSON.stringify({ measuredAt: new Date().toISOString().slice(0, 10), packs, unmeasured: UNMEASURED }, null, 1)}\n`,
);
