/** Marks every free-text position of a fixture; it must never reach a Scan, a Report or the cache. */
export const CANARY = "CANARY-LS";

/**
 * Canary text exactly `length` UTF-16 code units long (the unit loadsheet counts characters in).
 * Text shorter than the canary holds only a prefix of it, so findCanary cannot see it.
 */
export function canaryText(length: number): string {
  return CANARY.repeat(Math.ceil(length / CANARY.length)).slice(0, length);
}

export type JsonPath = readonly (string | number)[];

export interface SanitizeContext {
  /** Where the value sits, from the root: object keys and array indices. */
  readonly path: JsonPath;
  /** The same input always gets the same name within one run, and no two inputs share one. */
  readonly pseudonym: (kind: string, input: string) => string;
  /** Sanitizes `value` as if it sat at `path`, under the same policy. */
  readonly sanitize: (value: unknown, path: JsonPath) => unknown;
}

export type Action =
  /** Keep the value as it is, subtree included (enums such as a line's `type`). */
  | "keep"
  /** Replace a string with canary text of its length. */
  | "length"
  /** Replace the whole subtree with the canary (objects whose keys are private, such as tool input). */
  | "opaque"
  /** Replace a string with a stable invented name, `${kind}-${n}`. */
  | { readonly pseudonym: string }
  | ((value: unknown, context: SanitizeContext) => unknown);

export interface Policy {
  /**
   * Path pattern to action; the first pattern that matches wins. A pattern is dot-separated
   * segments: a key, `*` for any one key or index, `**` for any number of segments.
   * A value no rule matches is default-denied: strings become the canary, other values recurse.
   * A key that is not a plain identifier (it holds a slash, a space, an `@`) came from data,
   * so it becomes a `key-N` pseudonym; rules match the original key.
   */
  readonly rules?: Readonly<Record<string, Action>>;
}

type Matcher = (path: JsonPath) => boolean;

const PLAIN_KEY = /^[\w$.-]+$/;

function compile(pattern: string): Matcher {
  const segments = pattern === "" ? [] : pattern.split(".");
  const match = (s: number, p: number, path: JsonPath): boolean => {
    if (s === segments.length) return p === path.length;
    const segment = segments[s]!;
    if (segment === "**") {
      for (let skip = p; skip <= path.length; skip += 1) if (match(s + 1, skip, path)) return true;
      return false;
    }
    if (p === path.length) return false;
    return (segment === "*" || segment === String(path[p])) && match(s + 1, p + 1, path);
  };
  return (path) => match(0, 0, path);
}

export interface Sanitizer {
  sanitize(value: unknown): unknown;
  /** Sanitizes each line; blank lines, line endings and the line count are kept, a non-JSON line becomes the canary. */
  sanitizeJsonl(text: string): string;
}

/** One run: pseudonyms are shared by every value it sanitizes. */
export function createSanitizer(policy: Policy = {}): Sanitizer {
  const rules = Object.entries(policy.rules ?? {}).map(
    ([pattern, action]) => [compile(pattern), action] as const,
  );
  const names = new Map<string, Map<string, string>>();
  const taken = new Map<string, string>();

  const pseudonym = (kind: string, input: string): string => {
    let table = names.get(kind);
    if (table === undefined) names.set(kind, (table = new Map()));
    const known = table.get(input);
    if (known !== undefined) return known;
    const name = `${kind}-${table.size + 1}`;
    const owner = taken.get(name);
    if (owner !== undefined) throw new Error(`pseudonym ${name} is already taken by kind ${owner}`);
    taken.set(name, kind);
    table.set(input, name);
    return name;
  };

  const walk = (value: unknown, path: JsonPath): unknown => {
    const action = rules.find(([matches]) => matches(path))?.[1];
    if (action === "keep") return value;
    if (action === "opaque") return CANARY;
    if (typeof action === "function") return action(value, { path, pseudonym, sanitize: walk });
    if (typeof value === "string") {
      if (action === "length") return canaryText(value.length);
      if (action !== undefined) return pseudonym(action.pseudonym, value);
      return CANARY;
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, [...path, index]));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          PLAIN_KEY.test(key) ? key : pseudonym("key", key),
          walk(item, [...path, key]),
        ]),
      );
    }
    return value;
  };

  return {
    sanitize: (value) => walk(value, []),
    sanitizeJsonl: (text) =>
      text
        .split("\n")
        .map((line) => {
          const cr = line.endsWith("\r") ? "\r" : "";
          const body = cr ? line.slice(0, -1) : line;
          if (body.trim() === "") return line;
          let value: unknown;
          try {
            value = JSON.parse(body);
          } catch {
            return CANARY + cr;
          }
          return JSON.stringify(walk(value, [])) + cr;
        })
        .join("\n"),
  };
}

export const sanitize = (value: unknown, policy?: Policy): unknown =>
  createSanitizer(policy).sanitize(value);

export const sanitizeJsonl = (text: string, policy?: Policy): string =>
  createSanitizer(policy).sanitizeJsonl(text);

/**
 * An action for file paths: a home directory becomes `~`, every other segment a `dir-N` pseudonym,
 * and the file name a `file-N` pseudonym with its extension. Names in `keep` stay (`SKILL.md`, `.claude`).
 */
export function pathPseudonym(options: { readonly keep?: readonly string[] } = {}): Action {
  const keep = new Set(options.keep);
  return (value, { pseudonym }) => {
    if (typeof value !== "string") return CANARY;
    const separator = value.includes("\\") && !value.includes("/") ? "\\" : "/";
    const home =
      /^(?:\/(?:var\/)?home\/[^/]+|\/Users\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+|~)(?=[/\\]|$)/.exec(
        value,
      );
    const rest = home ? value.slice(home[0].length) : value;
    const segments = rest.split(separator);
    const last = segments.length - 1;
    const mapped = segments.map((segment, index) => {
      if (segment === "" || segment === "." || segment === ".." || keep.has(segment)) {
        return segment;
      }
      if (index < last) return pseudonym("dir", segment);
      const dot = segment.lastIndexOf(".");
      const extension = dot > 0 ? segment.slice(dot) : "";
      return pseudonym("file", segment) + extension;
    });
    return (home ? "~" : "") + mapped.join(separator);
  };
}
