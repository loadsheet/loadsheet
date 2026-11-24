import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MAX_REACH_ENTRIES, reachesOf } from "../src/node/reach.ts";

// A layout is a list of folders, files and links under a base folder; `abs` link targets are
// written as absolute paths under the base, others as given.
type Op =
  | { dir: string }
  | { file: string; text: string }
  | { link: string; to: string; abs?: boolean };

const build = (base: string, ops: readonly Op[]) => {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  for (const op of ops) {
    if ("dir" in op) {
      mkdirSync(join(base, op.dir), { recursive: true });
    } else if ("file" in op) {
      mkdirSync(dirname(join(base, op.file)), { recursive: true });
      writeFileSync(join(base, op.file), op.text);
    } else {
      mkdirSync(dirname(join(base, op.link)), { recursive: true });
      symlinkSync(op.abs ? join(base, op.to) : op.to, join(base, op.link));
    }
  }
};

/** A link at `from` to `to`, both under the base, written relative to the link's folder. */
const relLink = (from: string, to: string): Op => ({
  link: from,
  to: relative(dirname(from), to) || ".",
});

/** An Item's path on the disk: `~/...` under `home`, else as it is. */
const onDisk = (path: string, home: string) =>
  path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;

/** Whether a path resolves, and the names and contents of its tree, following links. */
const stateOf = (path: string): string => {
  const out: string[] = [];
  const walk = (at: string, name: string, ancestors: readonly string[]) => {
    let info;
    try {
      info = statSync(at);
    } catch {
      out.push(`${name} missing`);
      return;
    }
    if (!info.isDirectory()) {
      out.push(`${name}=${readFileSync(at, "utf8")}`);
      return;
    }
    const real = realpathSync(at);
    if (ancestors.includes(real)) {
      out.push(`${name} cycle`);
      return;
    }
    out.push(`${name}/`);
    for (const entry of readdirSync(at).sort()) {
      walk(join(at, entry), `${name}/${entry}`, [...ancestors, real]);
    }
  };
  walk(path, ".", []);
  return out.join("\n");
};

/** A small deterministic generator (mulberry32). */
const random = (seed: number) => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    chance: (p: number) => next() < p,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!,
  };
};

const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\n`;

const FEATURES = [
  "folder",
  "skill",
  "nested-folder",
  "skills-link",
  "chain",
  "file-link",
  "nested-skill",
  "dangling",
] as const;

interface Layout {
  ops: Op[];
  /** The home folder under the base: `real`, or `home` when the home is a link to it. */
  home: string;
  /** Item paths as a Scan spells them; `@` stands for the base. */
  candidates: string[];
}

/**
 * A home of skills folders with skill folders in them, and links drawn at random from the list
 * the relation must hold for. Every path is under `real/`; candidates are spelled `~/...`.
 */
const generate = (seed: number): Layout => {
  const r = random(seed);
  const ops = new Map<string, Op>();
  const put = (op: Op) => ops.set("dir" in op ? op.dir : "file" in op ? op.file : op.link, op);
  const candidates: string[] = [];
  const skills: string[] = [];
  const roots: string[] = [];
  const homeLinked = r.chance(0.3);

  const rootCount = r.int(2, 3);
  for (let i = 0; i < rootCount; i += 1) {
    const root = `real/r${i}/skills`;
    roots.push(root);
    put({ dir: root });
    for (let j = 0; j < r.int(1, 3); j += 1) {
      const skill = `${root}/k${j}`;
      skills.push(skill);
      put({ file: `${skill}/SKILL.md`, text: skillMd(`k${i}${j}`) });
      put({ file: `${skill}/ref/notes.md`, text: `notes ${i}${j}` });
      candidates.push(skill);
    }
  }
  put({ file: "real/lib/x/SKILL.md", text: skillMd("x") });
  put({ file: "real/lib/x/data.txt", text: "x" });

  let links = 0;
  const newEntry = () => `${r.pick(roots)}/l${(links += 1)}`;
  const features = Array.from({ length: r.int(2, 5) }, () => r.pick(FEATURES));
  for (const feature of features) {
    switch (feature) {
      case "folder": {
        const link = newEntry();
        put(r.chance(0.5) ? relLink(link, "real/lib/x") : { link, to: "real/lib/x", abs: true });
        candidates.push(link);
        if (r.chance(0.5)) candidates.push("real/lib/x");
        break;
      }
      case "skill": {
        const link = newEntry();
        const target = r.pick(skills);
        put(r.chance(0.5) ? relLink(link, target) : { link, to: target, abs: true });
        candidates.push(link);
        break;
      }
      case "nested-folder": {
        const link = newEntry();
        const target = `${r.pick(skills)}/ref`;
        put({ file: `${target}/SKILL.md`, text: skillMd("ref") });
        put(relLink(link, target));
        candidates.push(link);
        if (r.chance(0.5)) candidates.push(target);
        break;
      }
      case "skills-link": {
        // A skills folder that is a link, to another skills folder or to a store of skills.
        const root = `real/r${rootCount + links}/skills`;
        links += 1;
        if (r.chance(0.5)) {
          const target = r.pick(roots);
          put(relLink(root, target));
          for (const skill of skills.filter((s) => s.startsWith(`${target}/`))) {
            candidates.push(`${root}/${skill.slice(target.length + 1)}`);
          }
        } else {
          const store = `real/store${links}`;
          put({ file: `${store}/s/SKILL.md`, text: skillMd("s") });
          put(relLink(root, store));
          candidates.push(`${root}/s`);
          if (r.chance(0.5)) candidates.push(`${store}/s`);
        }
        break;
      }
      case "chain": {
        // Two or three hops, one of them a link inside another skill's folder.
        const link = newEntry();
        const through = r.pick(skills);
        const end = r.pick(skills);
        const hop = `${through}/hop${links}`;
        put(relLink(hop, end));
        if (r.chance(0.5)) {
          put(relLink(link, hop));
        } else {
          const middle = `real/chain/c${links}`;
          put(relLink(middle, hop));
          put(relLink(link, middle));
        }
        candidates.push(link);
        break;
      }
      case "file-link": {
        // A SKILL.md, or another file, that is a link to a file inside another skill.
        const skill = r.pick(skills);
        const other = r.pick(skills.filter((s) => s !== skill));
        if (!other) break;
        if (r.chance(0.5)) put(relLink(`${skill}/SKILL.md`, `${other}/SKILL.md`));
        else put(relLink(`${skill}/extra${links}.md`, `${other}/ref/notes.md`));
        links += 1;
        break;
      }
      case "nested-skill": {
        const nested = `${r.pick(skills)}/sub`;
        put({ file: `${nested}/SKILL.md`, text: skillMd("sub") });
        candidates.push(nested);
        break;
      }
      case "dangling": {
        if (r.chance(0.5)) {
          put({ link: `${r.pick(skills)}/broken`, to: "../gone" });
        } else {
          const link = newEntry();
          put({ link, to: "gone" });
          candidates.push(link);
        }
        break;
      }
    }
  }

  // Each candidate spelled from the home, some with a doubled slash or through the real home path.
  const spelled = new Set<string>();
  for (const candidate of candidates) {
    const rest = candidate.slice("real/".length);
    spelled.add(`~/${rest}`);
    if (r.chance(0.15)) spelled.add(`~/${rest.replace("/", "//")}`);
    if (homeLinked && r.chance(0.15)) spelled.add(`@/${candidate}`);
  }
  const ordered = [...ops.values()];
  if (homeLinked) ordered.unshift({ link: "home", to: "real" });
  return { ops: ordered, home: homeLinked ? "home" : "real", candidates: [...spelled] };
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "loadsheet-reach-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const LAYOUTS = 160;

describe("reaches, against rm -r", () => {
  it.each(Array.from({ length: LAYOUTS }, (_, seed) => seed))("layout %i", (seed) => {
    const layout = generate(seed);
    const base = join(tmp, `layout-${seed}`);
    const home = join(base, layout.home);
    const resolve = (path: string) => path.replace(/^@/u, base);
    build(base, layout.ops);
    const items = layout.candidates.map(resolve).filter((path) => {
      try {
        readFileSync(join(onDisk(path, home), "SKILL.md"));
        return true;
      } catch {
        return false;
      }
    });
    const reaches = reachesOf(items, home);
    const states = () => new Map(items.map((path) => [path, stateOf(onDisk(path, home))]));
    const missed: string[] = [];
    for (const removed of items) {
      const reached = reaches.get(removed);
      if (reached === undefined) continue;
      build(base, layout.ops);
      const before = states();
      execFileSync("rm", ["-r", onDisk(removed, home)]);
      const after = states();
      for (const path of items) {
        if (path === removed || before.get(path) === after.get(path)) continue;
        if (!reached.includes(path)) missed.push(`${removed} -> ${path}`);
      }
    }
    rmSync(base, { recursive: true, force: true });
    expect(missed).toEqual([]);
  });
});

/** Builds `ops` and returns what each Item reaches, keyed and listed by its spelling. */
const reachesIn = (name: string, ops: Op[], items: string[], home = "real") => {
  const base = join(tmp, name);
  build(base, ops);
  const resolve = (path: string) => path.replace(/^@/u, base);
  const unresolve = (path: string) =>
    path.startsWith(base) ? `@${path.slice(base.length)}` : path;
  const found = reachesOf(items.map(resolve), join(base, home));
  return Object.fromEntries(
    [...found].map(([path, reached]) => [unresolve(path), reached?.map(unresolve)]),
  );
};

const skill = (path: string, text = "skill"): Op[] => [
  { file: `${path}/SKILL.md`, text },
  { file: `${path}/ref/notes.md`, text: "notes" },
];

describe("reaches, by hand", () => {
  it("is empty for every Item of a home of plain folders", () => {
    expect(
      reachesIn(
        "plain",
        [...skill("real/a/skills/one"), ...skill("real/a/skills/two"), ...skill("real/b/three")],
        ["~/a/skills/one", "~/a/skills/two", "~/b/three"],
      ),
    ).toEqual({ "~/a/skills/one": [], "~/a/skills/two": [], "~/b/three": [] });
  });

  it("a skill folder that is a link to another folder and that folder reach each other", () => {
    expect(
      reachesIn(
        "folder",
        [...skill("real/lib/x"), relLink("real/s/a", "real/lib/x"), ...skill("real/s/b")],
        ["~/s/a", "~/lib/x", "~/s/b"],
      ),
    ).toEqual({ "~/s/a": ["~/lib/x"], "~/lib/x": ["~/s/a"], "~/s/b": [] });
  });

  it("a link to another skill and that skill reach each other", () => {
    expect(
      reachesIn(
        "skill",
        [...skill("real/r0/s/b"), relLink("real/r1/s/a", "real/r0/s/b"), ...skill("real/r0/s/c")],
        ["~/r1/s/a", "~/r0/s/b", "~/r0/s/c"],
      ),
    ).toEqual({ "~/r1/s/a": ["~/r0/s/b"], "~/r0/s/b": ["~/r1/s/a"], "~/r0/s/c": [] });
  });

  it("a link to a folder nested in another skill and that skill reach each other", () => {
    expect(
      reachesIn(
        "nested-folder",
        [
          ...skill("real/s/b"),
          { file: "real/s/b/ref/SKILL.md", text: "ref" },
          relLink("real/s/a", "real/s/b/ref"),
        ],
        ["~/s/a", "~/s/b"],
      ),
    ).toEqual({ "~/s/a": ["~/s/b"], "~/s/b": ["~/s/a"] });
  });

  it("a skills folder that is a link gives one skill two paths that reach each other", () => {
    expect(
      reachesIn(
        "skills-link",
        [...skill("real/r0/s/a"), ...skill("real/r0/s/b"), relLink("real/r1/s", "real/r0/s")],
        ["~/r0/s/a", "~/r1/s/a", "~/r0/s/b"],
      ),
    ).toEqual({ "~/r0/s/a": ["~/r1/s/a"], "~/r1/s/a": ["~/r0/s/a"], "~/r0/s/b": [] });
  });

  it("a link chain through another skill's folder reaches it and is reached by it", () => {
    expect(
      reachesIn(
        "chain",
        [
          ...skill("real/s/b"),
          ...skill("real/s/c"),
          relLink("real/s/b/hop", "real/s/c"),
          relLink("real/chain/c1", "real/s/b/hop"),
          relLink("real/s/a", "real/chain/c1"),
        ],
        ["~/s/a", "~/s/b", "~/s/c"],
      ),
    ).toEqual({ "~/s/a": ["~/s/b", "~/s/c"], "~/s/b": ["~/s/a"], "~/s/c": ["~/s/a", "~/s/b"] });
  });

  it.each([
    [
      "SKILL.md",
      [
        { file: "real/s/a/ref/notes.md", text: "notes" },
        relLink("real/s/a/SKILL.md", "real/s/b/SKILL.md"),
      ],
    ],
    ["another file", [...skill("real/s/a"), relLink("real/s/a/extra.md", "real/s/b/ref/notes.md")]],
  ])("a %s that is a link into another skill is reached by that skill", (name, own) => {
    expect(
      reachesIn(`file-link-${name.length}`, [...own, ...skill("real/s/b")], ["~/s/a", "~/s/b"]),
    ).toEqual({ "~/s/a": [], "~/s/b": ["~/s/a"] });
  });

  it("a skill nested in a skill and its parent reach each other", () => {
    expect(
      reachesIn(
        "nested-skill",
        [...skill("real/s/a"), ...skill("real/s/a/sub"), ...skill("real/s/b")],
        ["~/s/a", "~/s/a/sub", "~/s/b"],
      ),
    ).toEqual({ "~/s/a": ["~/s/a/sub"], "~/s/a/sub": ["~/s/a"], "~/s/b": [] });
  });

  it("a dangling link, inside a skill or as an Item, is known and reaches nothing", () => {
    expect(
      reachesIn(
        "dangling",
        [
          ...skill("real/s/a"),
          ...skill("real/s/b"),
          { link: "real/s/a/broken", to: "../gone" },
          { link: "real/s/d", to: "gone" },
        ],
        ["~/s/a", "~/s/b", "~/s/d"],
      ),
    ).toEqual({ "~/s/a": [], "~/s/b": [], "~/s/d": [] });
  });

  it("a home behind a link is one place with its real path", () => {
    expect(
      reachesIn(
        "home-link",
        [...skill("real/s/a"), ...skill("real/s/b"), { link: "home", to: "real" }],
        ["~/s/a", "@/real/s/a", "~/s/b"],
        "home",
      ),
    ).toEqual({ "~/s/a": ["@/real/s/a"], "@/real/s/a": ["~/s/a"], "~/s/b": [] });
  });

  it("a doubled slash is the same place", () => {
    expect(
      reachesIn(
        "double-slash",
        [...skill("real/s/a"), ...skill("real/s/b")],
        ["~/s/a", "~//s/a", "~/s//b/"],
      ),
    ).toEqual({ "~/s/a": ["~//s/a"], "~//s/a": ["~/s/a"], "~/s//b/": [] });
  });

  it("a path that is neither under the home nor absolute is unknown and every other Item lists it", () => {
    const base = join(tmp, "relative");
    build(base, skill("real/s/a"));
    expect(reachesOf(["~/s/a", "s/a", ".agents/skills/a"], join(base, "real"))).toEqual(
      new Map([
        ["~/s/a", [".agents/skills/a", "s/a"]],
        ["s/a", undefined],
        [".agents/skills/a", undefined],
      ]),
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "an unreadable folder is unknown and every other Item lists it",
    () => {
      const ops = [...skill("real/s/a"), ...skill("real/s/b"), ...skill("real/s/c")];
      const base = join(tmp, "unreadable");
      try {
        build(base, ops);
        chmodSync(join(base, "real/s/a/ref"), 0o000);
        expect(reachesOf(["~/s/a", "~/s/b", "~/s/c"], join(base, "real"))).toEqual(
          new Map([
            ["~/s/a", undefined],
            ["~/s/b", ["~/s/a"]],
            ["~/s/c", ["~/s/a"]],
          ]),
        );
      } finally {
        chmodSync(join(base, "real/s/a/ref"), 0o755);
      }
    },
  );

  it("a link named node_modules or .git is followed to where it leads", () => {
    expect(
      reachesIn(
        "skipped-name",
        [
          ...skill("real/s/a"),
          ...skill("real/s/b"),
          ...skill("real/s/c"),
          { file: "real/s/a/content.md", text: "resource" },
          { link: "real/s/b/node_modules", to: "../a/content.md" },
          { link: "real/s/c/.git", to: "../a" },
          { file: "real/s/a/node_modules/dep/index.js", text: "" },
        ],
        ["~/s/a", "~/s/b", "~/s/c"],
      ),
    ).toEqual({ "~/s/a": ["~/s/b", "~/s/c"], "~/s/b": [], "~/s/c": [] });
  });

  it("a name or a link target that is not UTF-8 is unknown and every other Item lists it", () => {
    const base = join(tmp, "not-utf8");
    build(base, [...skill("real/s/a"), ...skill("real/s/b"), ...skill("real/s/c")]);
    const bytes = (text: string) => Buffer.concat([Buffer.from(text), Buffer.from([0xff])]);
    // b links to a file of a under a name that is not UTF-8; c under a plain name, through a
    // target that is not.
    symlinkSync("../a/SKILL.md", bytes(join(base, "real/s/b/")));
    symlinkSync(bytes("../a/"), join(base, "real/s/c/link"));
    const reaches = reachesOf(["~/s/a", "~/s/b", "~/s/c"], join(base, "real"));
    expect(Object.fromEntries(reaches)).toEqual({
      "~/s/a": ["~/s/b", "~/s/c"],
      "~/s/b": undefined,
      "~/s/c": undefined,
    });
  });

  it("a folder over the cap is unknown and every other Item lists it", () => {
    const ops: Op[] = [...skill("real/s/a"), ...skill("real/s/b")];
    for (let index = 0; index < MAX_REACH_ENTRIES; index += 1) {
      ops.push({ file: `real/s/a/many/${index}`, text: "" });
    }
    expect(reachesIn("cap", ops, ["~/s/a", "~/s/b"])).toEqual({
      "~/s/a": undefined,
      "~/s/b": ["~/s/a"],
    });
  });

  it("a link loop is unknown", () => {
    expect(
      reachesIn(
        "loop",
        [
          ...skill("real/s/a"),
          ...skill("real/s/b"),
          { link: "real/s/a/x", to: "y" },
          { link: "real/s/a/y", to: "x" },
        ],
        ["~/s/a", "~/s/b"],
      ),
    ).toEqual({ "~/s/a": undefined, "~/s/b": ["~/s/a"] });
  });
});
