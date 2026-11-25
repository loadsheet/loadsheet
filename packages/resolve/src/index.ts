import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packReport } from "@loadsheet/core";
import { claudeCode } from "@loadsheet/harnesses";
import { memoryFiles, type Files, type Harness } from "@loadsheet/kit";
import { ArchiveTooLargeError, githubFiles } from "@loadsheet/kit/node";
import { defaultConfig, type Report, type ResolvedConfig } from "@loadsheet/schema";
import { isDiagnostic, resolveSource, type SkillInfo, type SkillSource } from "skills";
import pkg from "../package.json" with { type: "json" };

/** Why a source could not be weighed. */
export type ResolveErrorCode =
  | "unsupported-source"
  | "not-found"
  | "too-large"
  | "no-skills"
  | "timeout";

export class ResolveError extends Error {
  readonly code: ResolveErrorCode;

  constructor(code: ResolveErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResolveError";
    this.code = code;
  }
}

/** A GitHub source as the `skills` CLI reads it. */
export interface PackSource {
  owner: string;
  repo: string;
  /** A branch, tag or commit; the default branch when absent. */
  ref?: string;
  /** A folder inside the repository, without slashes at either end. */
  subpath?: string;
  /** The skill an `owner/repo@skill` input asks for; the source still lists every skill. */
  skill?: string;
}

// The renames `skills` applies before it reads a source.
const SOURCE_ALIASES: Record<string, string> = {
  "coinbase/agentWallet": "coinbase/agentic-wallet-skills",
  "vercel-labs/vercel-skills": "vercel-labs/agent-skills",
};

const SEGMENT = /^[\w.-]+$/u;
// `owner/repo@<pin>` is a ref only when it looks like a version or a full commit, as in `skills`.
const VERSION_PIN = /^v?\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$|^[0-9a-f]{40}$/iu;

const unsupported = (input: string, why: string): ResolveError =>
  new ResolveError(
    "unsupported-source",
    `${why}: ${input}\nExpected owner/repo, owner/repo/folder, owner/repo@ref or https://github.com/<owner>/<repo>[/tree/<ref>[/<folder>]]`,
  );

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Reads a GitHub source the way `skills add` does: `owner/repo`, `owner/repo/folder`,
 * `owner/repo@ref`, `github:owner/repo`, a github.com URL with `tree/<ref>[/<folder>]`, and a
 * `#ref` fragment. Throws `unsupported-source` on anything else: a local path, `file:`, `ssh:`,
 * `git@`, GitLab or another host is never read here.
 */
export const parsePackSource = (input: string): PackSource => {
  const raw = input.trim();
  if (!raw) throw unsupported(input, "No source given");
  if (/^(?:[/\\~.]|[a-z]:[/\\])/iu.test(raw)) throw unsupported(input, "Local paths are not read");

  const hash = raw.indexOf("#");
  let base = hash === -1 ? raw : raw.slice(0, hash);
  const fragment = hash === -1 ? "" : raw.slice(hash + 1);
  const at = fragment.indexOf("@");
  const fragmentRef = decode(at === -1 ? fragment : fragment.slice(0, at)) || undefined;
  const fragmentSkill = (at === -1 ? "" : decode(fragment.slice(at + 1))) || undefined;

  base = SOURCE_ALIASES[base] ?? base;
  if (base.startsWith("github:")) base = base.slice("github:".length);
  base = SOURCE_ALIASES[base] ?? base;

  let source: PackSource;
  const host =
    /^(?:(https?):\/\/)?(?:[^@/?#]*@)?(?:www\.)?github\.com(?::\d*)?(\/[^?#]*)?(?:[?#].*)?$/iu.exec(
      base,
    );
  if (host) {
    const path = host[2] ?? "";
    if (/^\/[^/]+\/[^/]+\/(?:archive|raw|releases)\//u.test(path)) {
      throw unsupported(input, "Downloads are not read");
    }
    const tree = /^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+?))?\/?$/u.exec(path);
    const repo = /^\/([^/]+)\/([^/]+)/u.exec(path);
    if (tree) {
      source = { owner: tree[1]!, repo: tree[2]!, ref: decode(tree[3]!) };
      if (tree[4]) source.subpath = tree[4].split("/").map(decode).join("/");
    } else if (repo) {
      source = { owner: repo[1]!, repo: repo[2]! };
      if (fragmentRef) source.ref = fragmentRef;
    } else {
      throw unsupported(input, "Not a GitHub repository");
    }
  } else if (/^[a-z][a-z\d+.-]*:/iu.test(base) || base.includes(":")) {
    throw unsupported(input, "Only GitHub sources are read");
  } else {
    const pinned = /^([^/]+)\/([^/@]+)@(.+)$/u.exec(base);
    const shorthand = /^([^/]+)\/([^/]+)(?:\/(.+?))?\/?$/u.exec(base);
    if (pinned) {
      source = { owner: pinned[1]!, repo: pinned[2]! };
      const pin = pinned[3]!;
      if (!fragmentRef && !fragmentSkill && VERSION_PIN.test(pin)) source.ref = pin;
      else {
        if (fragmentRef) source.ref = fragmentRef;
        source.skill = fragmentSkill ?? pin;
      }
    } else if (shorthand) {
      source = { owner: shorthand[1]!, repo: shorthand[2]! };
      if (shorthand[3]) source.subpath = shorthand[3];
      if (fragmentRef) source.ref = fragmentRef;
      if (fragmentSkill) source.skill = fragmentSkill;
    } else {
      throw unsupported(input, "Not a GitHub source");
    }
  }

  source.repo = source.repo.replace(/\.git$/u, "");
  const valid = (segment: string) => SEGMENT.test(segment) && segment !== "." && segment !== "..";
  if (!valid(source.owner) || !valid(source.repo))
    throw unsupported(input, "Not a GitHub repository");
  if (source.subpath !== undefined) {
    source.subpath = source.subpath.replace(/^\/+|\/+$/gu, "");
    const segments = source.subpath.split("/");
    if (
      segments.some(
        (segment) =>
          segment === "" || segment === "." || segment === ".." || segment.includes("\\"),
      )
    ) {
      throw unsupported(input, "The folder leaves the repository");
    }
    if (!source.subpath) delete source.subpath;
  }
  return source;
};

/** The github.com URL of a source, which a pack Report names as its `source`. */
export const packSourceUrl = ({ owner, repo, ref, subpath }: PackSource): string => {
  if (ref === undefined && subpath === undefined) return `https://github.com/${owner}/${repo}`;
  const segments = [ref ?? "HEAD", ...(subpath?.split("/") ?? [])];
  return `https://github.com/${owner}/${repo}/tree/${segments.map(encodeURIComponent).join("/")}`;
};

/** Options for resolvePack. */
export interface ResolvePackOptions {
  /** Fetches the tarball from codeload.github.com; the only network `resolvePack` uses. */
  fetch?: typeof fetch;
  /** Aborting it stops the work with a `timeout` error. */
  signal?: AbortSignal;
  /** The most bytes the repository's tarball may hold, gzipped or unpacked. @default 64 MiB */
  maxBytes?: number;
  /** The harness the pack is weighed for. @default claudeCode */
  harness?: Harness;
  config?: ResolvedConfig;
  now?: Date;
  /** The Report's `tool`. @default loadsheet@<version> */
  tool?: string;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
// `skills` sends telemetry unless told not to; a server must not.
const SKILLS_CONFIG = { telemetry: false } as const;

const isAbort = (error: unknown) =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

// Paths come from a downloaded archive: one that would land outside the folder is dropped.
const safePath = (path: string) =>
  path !== "" &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

const writeTree = async (dir: string, files: Files) => {
  for (const path of files.paths) {
    if (!safePath(path)) continue;
    const text = await files.text(path);
    if (text === undefined) continue;
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
};

// `skills` matches a requested name exactly, ignoring case, else with spaces and `_` read as `-`.
const normalize = (name: string) => name.toLowerCase().replace(/[\s_]+/gu, "-");
const hasSkill = (skills: readonly SkillInfo[], name: string) =>
  skills.some((skill) => skill.name.toLowerCase() === name.toLowerCase()) ||
  skills.some((skill) => normalize(skill.name) === normalize(name));

/**
 * The skills `skills add` would find in a folder. For `owner/repo@skill` it includes internal
 * skills, and searches the whole tree when the skill is not in the usual places, as `skills` does.
 */
const discover = async (
  dir: string,
  skill: string | undefined,
  signal: AbortSignal | undefined,
) => {
  const open = (fullDepth: boolean): Promise<SkillSource> =>
    resolveSource(dir, {
      config: {
        ...SKILLS_CONFIG,
        ...(skill ? { includeInternal: true } : {}),
        ...(fullDepth ? { fullDepth } : {}),
      },
      ...(signal ? { signal } : {}),
      // A SKILL.md that `skills` skips is not one it would install; nothing else to report.
      onWarning: () => {},
    });
  const first = await open(false);
  try {
    if (skill === undefined || hasSkill(first.skills, skill)) return first.skills;
  } finally {
    await first.dispose();
  }
  const deep = await open(true);
  await deep.dispose();
  return deep.skills;
};

// An item's path is its SKILL.md's folder, or the file itself for a skill at the root.
const itemPathOf = (skillPath: string) => (skillPath === "." ? "SKILL.md" : skillPath);

const toResolveError = (
  error: unknown,
  signal: AbortSignal | undefined,
  label: string,
): unknown => {
  if (error instanceof ResolveError) return error;
  if (signal?.aborted || isAbort(error)) {
    return new ResolveError("timeout", `Reading ${label} took too long`, { cause: error });
  }
  if (error instanceof ArchiveTooLargeError) {
    return new ResolveError("too-large", `${label} is larger than ${error.limit} bytes`, {
      cause: error,
    });
  }
  if (isDiagnostic(error, "SKILLS_NO_VALID_SKILLS")) {
    return new ResolveError("no-skills", `${label} has no skills`, { cause: error });
  }
  return error;
};

/**
 * Weighs a public GitHub skills source as a pack Report. The tarball comes from codeload through
 * `fetch`, with no git; which folders are skills is decided by `skills`'s own discovery; their
 * weight comes from the harness's inventory, as in `loadsheet <URL>`. Throws ResolveError.
 */
export const resolvePack = async (
  input: string,
  options: ResolvePackOptions = {},
): Promise<Report> => {
  const source = parsePackSource(input);
  const url = packSourceUrl(source);
  const label = `${source.owner}/${source.repo}${source.ref ? `@${source.ref}` : ""}`;
  const { signal, harness = claudeCode, maxBytes = DEFAULT_MAX_BYTES } = options;
  const get = options.fetch ?? fetch;

  const guarded = (async (request: string, init?: RequestInit) => {
    const response = await get(request, { ...init, ...(signal ? { signal } : {}) });
    if (response.status === 404) {
      await response.body?.cancel();
      throw new ResolveError(
        "not-found",
        source.ref
          ? `GitHub has no ref ${source.ref} in ${source.owner}/${source.repo}, or the repository is private or missing`
          : `GitHub repository ${source.owner}/${source.repo} not found, or it is private`,
      );
    }
    return response;
  }) as typeof fetch;

  let dir: string | undefined;
  try {
    signal?.throwIfAborted();
    // The whole repository at the ref; the folder is cut here so a missing one is `not-found`.
    const repoUrl = packSourceUrl({ ...source, subpath: undefined });
    const repo = await githubFiles(repoUrl, { fetch: guarded, maxArchiveBytes: maxBytes });
    const prefix = source.subpath ? `${source.subpath}/` : "";
    const record: Record<string, string> = {};
    for (const path of repo.paths) {
      if (!path.startsWith(prefix)) continue;
      const text = await repo.text(path);
      if (text !== undefined) record[path.slice(prefix.length)] = text;
    }
    if (source.subpath && Object.keys(record).length === 0) {
      throw new ResolveError("not-found", `${label} has no folder ${source.subpath}`);
    }
    const files = memoryFiles(record, `${source.owner}/${source.repo}`);

    dir = await mkdtemp(join(tmpdir(), "loadsheet-resolve-"));
    await writeTree(dir, files);
    signal?.throwIfAborted();
    const skills = await discover(dir, source.skill, signal);

    // Only the folders `skills` found: a SKILL.md it skips, or one nested in a skill, is not installed.
    const skillPaths = skills.map((skill) => skill.path ?? ".");
    const inSkill = (path: string) =>
      skillPaths.some((skillPath) => skillPath === "." || path.startsWith(`${skillPath}/`));
    const kept = memoryFiles(
      Object.fromEntries(Object.entries(record).filter(([path]) => inSkill(path))),
      files.name,
    );
    const itemPaths = new Set(skillPaths.map(itemPathOf));
    const items = (await harness.inventory(kept)).filter((item) => itemPaths.has(item.path));
    if (items.length === 0) throw new ResolveError("no-skills", `${label} has no skills`);

    return packReport({
      items,
      harness,
      source: url,
      config: options.config ?? defaultConfig,
      now: options.now ?? new Date(),
      tool: options.tool ?? `loadsheet@${pkg.version}`,
    });
  } catch (error) {
    throw toResolveError(error, signal, label);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
};
