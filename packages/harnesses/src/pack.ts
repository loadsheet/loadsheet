import type { Files } from "@loadsheet/kit";
import { sha256 } from "@loadsheet/kit";
import type { Item, Kind } from "@loadsheet/schema";
import { readSkillMd, type SkillMd } from "./skill-md.ts";

/** How a harness lists one entry, which decides what it costs every session. */
export interface PackListing {
  /** The harness id that goes on each item. */
  harness: string;
  /** The description the harness lists for an entry. */
  description(skill: SkillMd): string | undefined;
  /** Characters the harness's listing spends on an entry of this kind, name and frontmatter. */
  listedChars(name: string, skill: SkillMd, kind: Kind): number;
}

const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";
const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const pluginName = async (files: Files) => {
  const manifest = await files.text(PLUGIN_MANIFEST);
  if (manifest === undefined) return undefined;
  try {
    const { name } = JSON.parse(manifest) as { name?: unknown };
    if (typeof name === "string" && name) return name;
  } catch {
    // A manifest that is not JSON names nothing; the folder still counts as a plugin.
  }
  return undefined;
};

/**
 * Everything a pack installs: each `SKILL.md` anywhere in it, and, when it is a plugin
 * (`.claude-plugin/plugin.json`), its `commands/*.md` and `agents/*.md`, named `plugin:name`.
 * The pack's own root AGENTS.md and CLAUDE.md are its development instructions, not installed.
 */
export const packInventory = async (files: Files, listing: PackListing): Promise<Item[]> => {
  const isPlugin = files.paths.includes(PLUGIN_MANIFEST);
  const plugin = isPlugin ? ((await pluginName(files)) ?? files.name?.split("/").pop()) : undefined;
  const pack = files.name ?? plugin;
  const qualify = (name: string) => (plugin ? `${plugin}:${name}` : name);

  const entries: { file: string; path: string; kind: Kind; fallback: string }[] = [];
  for (const file of files.paths) {
    if (baseOf(file) === "SKILL.md") {
      const dir = dirOf(file);
      entries.push({
        file,
        path: dir || file,
        kind: "skill",
        fallback: dir ? baseOf(dir) : (pack?.split("/").pop() ?? "skill"),
      });
    } else if (isPlugin && /^(commands|agents)\/[^/]+\.md$/u.test(file)) {
      entries.push({
        file,
        path: file,
        kind: file.startsWith("commands/") ? "skill" : "subagent",
        fallback: baseOf(file).slice(0, -3),
      });
    }
  }

  const items: Item[] = [];
  for (const { file, path, kind, fallback } of entries) {
    const source = await files.text(file);
    if (source === undefined) continue;
    const skill = readSkillMd(source);
    // Commands are named after their file; skills and subagents by their frontmatter name. Claude
    // Code refuses a name with a control character, `<` or `>`, and one with a slash would read as
    // a path in the Report; the folder names those entries instead.
    const named = skill.name !== undefined && !/[\\/<>\p{Cc}]/u.test(skill.name);
    const name = qualify(named && !file.startsWith("commands/") ? skill.name! : fallback);
    const listed = listing.listedChars(name, skill, kind);
    const item: Item = {
      id: `${kind}:${name}`,
      ref: { kind, name },
      harnesses: [listing.harness],
      scope: plugin ? "plugin" : "user",
      managedBy: plugin ? "plugin" : "skills",
      path,
      digest: await sha256(source),
      chars: { listed, body: skill.bodyChars },
      modelInvocable: !skill.disableModelInvocation,
    };
    if (pack) item.pack = pack;
    const description = listing.description(skill);
    if (description) item.description = description;
    items.push(item);
  }
  return items;
};
