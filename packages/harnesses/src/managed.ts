// What installed a skill folder, from the records the installers leave behind. Reads files only;
// it never runs fleetrc or the skills CLI.
import type { Files } from "@loadsheet/kit";
import type { ManagedBy } from "@loadsheet/schema";

/** What installed one entry and where it came from. */
export interface Manager {
  readonly managedBy: ManagedBy;
  /** A fleetrc source or the skills CLI's `owner/repo`. */
  readonly pack?: string;
}

/** The file fleetrc writes in every folder it links skills into. */
export const FLEETRC_MANIFEST = ".fleetrc-manifest.json";
/** The skills CLI's global lock: `$XDG_STATE_HOME/skills/` or `~/.agents/`. */
export const SKILLS_LOCK = ".skill-lock.json";

/** Where the skills CLI keeps its global lock, given the home directory and the environment. */
export const skillsLockPath = (home: string, env: Readonly<Record<string, string | undefined>>) => {
  const state = env.XDG_STATE_HOME?.trim();
  return state
    ? `${state.replace(/\/+$/u, "")}/skills/${SKILLS_LOCK}`
    : `${home}/.agents/${SKILLS_LOCK}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = async (files: Files, path: string): Promise<unknown> => {
  const text = await files.text(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * A source that is a plain identifier such as `owner/repo`: not a local path, which may name the
 * home directory, and not a URL, which may carry credentials.
 */
const plainSource = (source: string) => /^(?![/~.])[^\s@]+$/u.test(source) && !source.includes("://");

/** Name to source, for the links fleetrc's manifest says it made in `dir`. */
const fleetrcLinks = async (files: Files, dir: string) => {
  const manifest = await readJson(files, `${dir}/${FLEETRC_MANIFEST}`);
  const links = new Map<string, string>();
  if (!isRecord(manifest) || manifest.version !== 1 || !isRecord(manifest.links)) return links;
  for (const [name, link] of Object.entries(manifest.links)) {
    if (isRecord(link) && typeof link.source === "string") links.set(name, link.source);
  }
  return links;
};

/** Name to source, for the skills the skills CLI's lock (version 3 or later) records. */
const lockedSkills = async (files: Files) => {
  const skills = new Map<string, string | undefined>();
  // The XDG lock wins, the way the CLI reads it when XDG_STATE_HOME is set.
  const paths = files.paths
    .filter((path) => path.endsWith(`/${SKILLS_LOCK}`))
    .sort(
      (a, b) =>
        Number(b.endsWith(`/skills/${SKILLS_LOCK}`)) - Number(a.endsWith(`/skills/${SKILLS_LOCK}`)),
    );
  const lock = paths[0] === undefined ? undefined : await readJson(files, paths[0]);
  if (!isRecord(lock) || typeof lock.version !== "number" || lock.version < 3) return skills;
  if (!isRecord(lock.skills)) return skills;
  for (const [name, entry] of Object.entries(lock.skills)) {
    const source = isRecord(entry) && typeof entry.source === "string" ? entry.source : undefined;
    skills.set(name, source || undefined);
  }
  return skills;
};

/**
 * Who manages each entry of the folder `dir` (keyed as `files` keys it): fleetrc when its manifest
 * there records the entry, the skills CLI when its lock does, the user by hand otherwise.
 */
export const readManagers = async (
  files: Files,
  dir: string,
): Promise<(name: string) => Manager> => {
  const [links, locked] = await Promise.all([fleetrcLinks(files, dir), lockedSkills(files)]);
  return (name) => {
    const fleetrc = links.get(name);
    const managedBy = fleetrc !== undefined ? "fleetrc" : locked.has(name) ? "skills" : "hand";
    const source = fleetrc ?? locked.get(name);
    return source !== undefined && plainSource(source)
      ? { managedBy, pack: source }
      : { managedBy };
  };
};
