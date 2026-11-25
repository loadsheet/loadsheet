import { gunzipSync } from "node:zlib";
import { memoryFiles, type Files } from "../index.ts";
import { MAX_FILE_BYTES } from "./files.ts";

/** A GitHub repository, optionally at a ref and inside a folder. */
export interface GithubSource {
  owner: string;
  repo: string;
  /** A branch, tag or commit; the default branch when absent. */
  ref?: string;
  /** A folder inside the repository, without slashes at either end. */
  subdir?: string;
}

const SEGMENT = /^[\w.-]+$/u;

/**
 * Reads `https://github.com/<owner>/<repo>` with an optional `/tree/<ref>[/<subdir>]`.
 * A ref that contains a slash cannot be told from a folder, so its first segment is the ref.
 */
export const parseGithubUrl = (input: string): GithubSource => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Not a URL: ${input}`);
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error(`Only github.com URLs are supported, not ${url.hostname}`);
  }
  const [owner, rawRepo, tree, ref, ...subdir] = url.pathname.split("/").filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/u, "");
  const valid =
    owner &&
    repo &&
    SEGMENT.test(owner) &&
    SEGMENT.test(repo) &&
    (tree === undefined || (tree === "tree" && ref));
  if (!valid) {
    throw new Error(
      `Not a GitHub repository URL: ${input}\nExpected https://github.com/<owner>/<repo>[/tree/<ref>[/<folder>]]`,
    );
  }
  return {
    owner,
    repo,
    ...(ref ? { ref: decodeURIComponent(ref) } : {}),
    ...(subdir.length ? { subdir: subdir.map(decodeURIComponent).join("/") } : {}),
  };
};

/** The URL of what a GitHub URL points at, without its query, fragment or credentials. */
export const githubUrl = (input: string): string => {
  const { owner, repo, ref, subdir } = parseGithubUrl(input);
  const tree = ref
    ? `/tree/${[ref, ...(subdir?.split("/") ?? [])].map(encodeURIComponent).join("/")}`
    : "";
  return `https://github.com/${owner}/${repo}${tree}`;
};

const decoder = new TextDecoder();

const field = (block: Uint8Array, start: number, length: number) => {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
};

// Sizes are octal text, or base-256 when the high bit of the first byte is set.
const sizeOf = (block: Uint8Array) => {
  if ((block[124]! & 0x80) !== 0) {
    let size = 0;
    for (let i = 125; i < 136; i++) size = size * 256 + block[i]!;
    return size;
  }
  return Number.parseInt(field(block, 124, 12).trim() || "0", 8);
};

// A pax record is `<length> <key>=<value>\n`; the length counts the whole record in bytes.
const paxPath = (data: Uint8Array) => {
  let offset = 0;
  let path: string | undefined;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(decoder.decode(data.subarray(offset, space)), 10);
    if (!(length > 0)) break;
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1));
    if (record.startsWith("path=")) path = record.slice(5);
    offset += length;
  }
  return path;
};

/**
 * The regular files in an uncompressed tar archive (ustar, pax or GNU long names), as path to bytes.
 * Directories, links and pax global headers are skipped.
 */
export const readTar = (archive: Uint8Array): Map<string, Uint8Array> => {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let longPath: string | undefined;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = sizeOf(header);
    const type = String.fromCharCode(header[156]!);
    const data = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "x") longPath = paxPath(data) ?? longPath;
    else if (type === "L") longPath = field(data, 0, data.length);
    else if (type !== "g") {
      const prefix = field(header, 345, 155);
      const name = field(header, 0, 100);
      const path = longPath ?? (prefix ? `${prefix}/${name}` : name);
      longPath = undefined;
      if (type === "0" || type === "\0" || type === "7") files.set(path, data);
    }
  }
  return files;
};

/** Options for githubFiles; fetch is replaceable so tests need no network. */
export interface GithubFilesOptions {
  fetch?: typeof fetch;
  /** The largest file kept; a larger one is left out. */
  maxBytes?: number;
  /** The most bytes the tarball may hold, gzipped or unpacked; no limit when absent. */
  maxArchiveBytes?: number;
}

/** A tarball larger than `maxArchiveBytes`, gzipped or unpacked. */
export class ArchiveTooLargeError extends Error {
  readonly source: string;
  readonly limit: number;

  constructor(source: string, limit: number) {
    super(`${source} is larger than ${limit} bytes`);
    this.name = "ArchiveTooLargeError";
    this.source = source;
    this.limit = limit;
  }
}

// Stops reading as soon as the body passes the limit, so an oversized archive is never held whole.
const readCapped = async (response: Response, limit: number, source: string) => {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new ArchiveTooLargeError(source, limit);
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new ArchiveTooLargeError(source, limit);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

const gunzip = (bytes: Uint8Array, limit: number, source: string) => {
  if (!Number.isFinite(limit)) return gunzipSync(bytes);
  try {
    return gunzipSync(bytes, { maxOutputLength: limit });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new ArchiveTooLargeError(source, limit);
    }
    throw error;
  }
};

/**
 * A GitHub repository (or one folder of it) as Files named `owner/repo`, from codeload's tarball.
 * Throws on a URL that is not a GitHub repository, on a repository or ref GitHub does not serve,
 * and with ArchiveTooLargeError on a tarball past `maxArchiveBytes`.
 */
export const githubFiles = async (
  url: string,
  {
    fetch: get = fetch,
    maxBytes = MAX_FILE_BYTES,
    maxArchiveBytes = Number.POSITIVE_INFINITY,
  }: GithubFilesOptions = {},
): Promise<Files> => {
  const { owner, repo, ref, subdir } = parseGithubUrl(url);
  const name = `${owner}/${repo}`;
  const at = ref ?? "HEAD";
  const response = await get(
    `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(at)}`,
  );
  if (response.status === 404) {
    throw new Error(
      ref
        ? `GitHub has no ref ${ref} in ${name}, or the repository is private or missing`
        : `GitHub repository ${name} not found, or it is private`,
    );
  }
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${name}@${at}`);
  const source = `${name}@${at}`;
  const archive = readTar(
    gunzip(await readCapped(response, maxArchiveBytes, source), maxArchiveBytes, source),
  );

  // codeload puts everything under one `<repo>-<sha>/` folder.
  const prefix = subdir ? `${subdir}/` : "";
  const record: Record<string, string> = {};
  const utf8 = new TextDecoder();
  for (const [path, bytes] of archive) {
    const inRepo = path.slice(path.indexOf("/") + 1);
    if (!inRepo.startsWith(prefix) || bytes.length > maxBytes) continue;
    const relative = inRepo.slice(prefix.length);
    if (relative.split("/").some((segment) => segment === ".git" || segment === "node_modules"))
      continue;
    record[relative] = utf8.decode(bytes);
  }
  if (subdir && Object.keys(record).length === 0) {
    throw new Error(`${name}@${at} has no folder ${subdir}`);
  }
  return memoryFiles(record, name);
};
