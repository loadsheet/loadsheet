import { findCanary } from "@loadsheet/fixtures";
import { memoryFiles, sha256 } from "@loadsheet/kit";
import { describe, expect, it } from "vite-plus/test";
import { claudeCode } from "../src/index.ts";

const machine = claudeCode.machine!;
const SECRETS = ["sekrit", "jo@example.com", "/home/jo"];

const skill = (name: string, description: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody of ${name}.\n`;

const PLUGIN = "~/.claude/plugins/cache/market/kit/1.0.0";

const home = {
  "~/.claude.json": JSON.stringify({
    oauthAccount: { emailAddress: "jo@example.com" },
    mcpServers: {
      github: { command: "gh-mcp", env: { GITHUB_TOKEN: "sekrit-1" } },
      "my.server": {
        type: "http",
        url: "https://mcp.example.com",
        headers: { Authorization: "Bearer sekrit-2" },
      },
    },
    projects: { "/home/jo/app": { mcpServers: { local: { command: "x" } } } },
  }),
  "~/.agents/.skill-lock.json": JSON.stringify({
    version: 3,
    skills: { beta: { source: "acme/skills", sourceType: "github" } },
  }),
  "~/.claude/CLAUDE.md": "# Mine\n",
  "~/.claude/rules/team/style.md": "Be brief.",
  "~/.claude/settings.json": JSON.stringify({
    enabledPlugins: { "kit@market": true, "off@market": false },
    skillOverrides: { quiet: "name-only", gone: "off" },
  }),
  "~/.claude/skills/.fleetrc-manifest.json": JSON.stringify({
    version: 1,
    links: {
      alpha: { target: "/home/jo/.claude/skills/alpha", kind: "skill", source: "onmax-skills" },
    },
  }),
  "~/.claude/skills/alpha/SKILL.md": skill("alpha", "Does alpha."),
  "~/.claude/skills/beta/SKILL.md": skill("beta", "Does beta."),
  "~/.claude/skills/gone/SKILL.md": skill("gone", "Hidden."),
  "~/.claude/skills/quiet/SKILL.md": skill("quiet", "Listed by name."),
  "~/.claude/commands/git/push.md": "---\ndescription: Pushes.\n---\nSteps.",
  "~/.claude/agents/rev.md": skill("reviewer", "Reviews.", "tools: Read, Grep\n"),
  "~/.claude/plugins/installed_plugins.json": JSON.stringify({
    version: 2,
    plugins: {
      "kit@market": [
        { scope: "user", installPath: "/home/jo/.claude/plugins/cache/market/kit/1.0.0" },
      ],
      "off@market": [
        { scope: "user", installPath: "/home/jo/.claude/plugins/cache/market/off/1.0.0" },
      ],
    },
  }),
  [`${PLUGIN}/.claude-plugin/plugin.json`]: JSON.stringify({
    name: "kit",
    mcpServers: { db: { command: "db-mcp", env: { DB_PASSWORD: "sekrit-3" } } },
  }),
  [`${PLUGIN}/.mcp.json`]: JSON.stringify({
    mcpServers: { web: { url: "https://w", headers: { Cookie: "sekrit-4" } } },
  }),
  [`${PLUGIN}/skills/how/SKILL.md`]: skill("how", "Explains."),
  [`${PLUGIN}/agents/helper.md`]: skill("helper", "Helps."),
  "~/.claude/plugins/cache/market/off/1.0.0/skills/off/SKILL.md": skill("off", "Disabled plugin."),
};

const summary = async (record: Record<string, string>) =>
  (await machine.inventory(memoryFiles(record))).map(
    ({ id, scope, managedBy, pack, path, chars, modelInvocable }) => ({
      id,
      scope,
      managedBy,
      ...(pack === undefined ? {} : { pack }),
      path,
      listed: chars.listed,
      modelInvocable,
    }),
  );

describe("Claude Code machine inventory", () => {
  it("finds the user's instructions, skills, commands, subagents, plugins and MCP servers", async () => {
    expect(await summary(home)).toEqual([
      {
        id: "instructions:CLAUDE.md",
        scope: "user",
        managedBy: "hand",
        path: "~/.claude/CLAUDE.md",
        listed: 7,
        modelInvocable: true,
      },
      {
        id: "instructions:rules/team/style.md",
        scope: "user",
        managedBy: "hand",
        path: "~/.claude/rules/team/style.md",
        listed: 9,
        modelInvocable: true,
      },
      {
        id: "skill:alpha",
        scope: "user",
        managedBy: "fleetrc",
        pack: "onmax-skills",
        path: "~/.claude/skills/alpha",
        listed: "- alpha: Does alpha.\n".length,
        modelInvocable: true,
      },
      {
        id: "skill:beta",
        scope: "user",
        managedBy: "skills",
        pack: "acme/skills",
        path: "~/.claude/skills/beta",
        listed: "- beta: Does beta.\n".length,
        modelInvocable: true,
      },
      {
        id: "skill:gone",
        scope: "user",
        managedBy: "hand",
        path: "~/.claude/skills/gone",
        listed: 0,
        modelInvocable: false,
      },
      {
        id: "skill:quiet",
        scope: "user",
        managedBy: "hand",
        path: "~/.claude/skills/quiet",
        listed: "- quiet\n".length,
        modelInvocable: true,
      },
      {
        id: "skill:git:push",
        scope: "user",
        managedBy: "hand",
        path: "~/.claude/commands/git/push.md",
        listed: "- git:push: Pushes.\n".length,
        modelInvocable: true,
      },
      {
        id: "subagent:reviewer",
        scope: "user",
        managedBy: "hand",
        path: "~/.claude/agents/rev.md",
        listed: "- reviewer: Reviews. (Tools: Read, Grep)\n".length,
        modelInvocable: true,
      },
      {
        id: "subagent:kit:helper",
        scope: "plugin",
        managedBy: "plugin",
        pack: "kit",
        path: `${PLUGIN}/agents/helper.md`,
        listed: "- kit:helper: Helps. (Tools: All tools)\n".length,
        modelInvocable: true,
      },
      {
        id: "skill:kit:how",
        scope: "plugin",
        managedBy: "plugin",
        pack: "kit",
        path: `${PLUGIN}/skills/how`,
        listed: "- kit:how: Explains.\n".length,
        modelInvocable: true,
      },
      {
        id: "mcp:plugin_kit_web",
        scope: "plugin",
        managedBy: "plugin",
        pack: "kit",
        path: `${PLUGIN}/.mcp.json`,
        listed: 0,
        modelInvocable: true,
      },
      {
        id: "mcp:plugin_kit_db",
        scope: "plugin",
        managedBy: "plugin",
        pack: "kit",
        path: `${PLUGIN}/.claude-plugin/plugin.json`,
        listed: 0,
        modelInvocable: true,
      },
      {
        id: "mcp:github",
        scope: "user",
        managedBy: "hand",
        path: "~/.claude.json",
        listed: 0,
        modelInvocable: true,
      },
      {
        id: "mcp:my_server",
        scope: "user",
        managedBy: "hand",
        path: "~/.claude.json",
        listed: 0,
        modelInvocable: true,
      },
    ]);
  });

  it("puts no secret, account or absolute home path in an Item", async () => {
    const items = await machine.inventory(memoryFiles(home));
    expect(findCanary(items, SECRETS)).toEqual([]);
  });

  it("gives skills and subagents the description the harness lists, and nothing else one", async () => {
    const items = await machine.inventory(memoryFiles(home));
    const described = items.filter((item) => item.description !== undefined);
    expect(described.length).toBeGreaterThan(0);
    expect(described.every((item) => /^(skill|subagent):/u.test(item.id))).toBe(true);
  });

  it("digests an MCP server's config without its secrets", async () => {
    const digest = async (token: string) => {
      const items = await machine.inventory(
        memoryFiles({
          "~/.claude.json": JSON.stringify({
            mcpServers: { github: { command: "gh-mcp", env: { GITHUB_TOKEN: token } } },
          }),
        }),
      );
      return items[0]?.digest;
    };
    expect(await digest("sekrit-1")).toBe(await digest("sekrit-5"));
    expect(await digest("sekrit-1")).toBe(await sha256(JSON.stringify({ command: "gh-mcp" })));
  });

  it("drops every skill override when one value is unknown, as Claude Code does", async () => {
    const settings = JSON.stringify({ skillOverrides: { quiet: "name-only", gone: "hidden" } });
    const items = await summary({ ...home, "~/.claude/settings.json": settings });
    expect(items.find((item) => item.id === "skill:quiet")?.listed).toBe(
      "- quiet: Listed by name.\n".length,
    );
    expect(items.find((item) => item.id === "skill:gone")?.modelInvocable).toBe(true);
    // No plugin is enabled without settings.
    expect(items.some((item) => item.scope === "plugin")).toBe(false);
  });

  it("keeps an installer's source out of pack unless it is an identifier", async () => {
    const lock = (skills: Record<string, object>) =>
      summary({
        ...home,
        "~/.claude/skills/.fleetrc-manifest.json": JSON.stringify({ version: 1, links: {} }),
        "~/.agents/.skill-lock.json": JSON.stringify({ version: 3, skills }),
      });
    const pack = (items: Awaited<ReturnType<typeof summary>>, id: string) => {
      const { managedBy, pack } = items.find((item) => item.id === id)!;
      return { managedBy, pack };
    };
    const skills = await lock({
      alpha: { source: "/home/jo/src/alpha", sourceType: "local" },
      // A local folder can look like owner/repo; only its type tells.
      beta: { source: "client/private-skills", sourceType: "local" },
      gone: { source: "https://jo:sekrit@git.example.com/x.git", sourceType: "git" },
      quiet: { source: "work/../private", sourceType: "github" },
    });
    for (const id of ["skill:alpha", "skill:beta", "skill:gone", "skill:quiet"]) {
      expect(pack(skills, id)).toEqual({ managedBy: "skills", pack: undefined });
    }
    // Only a type the skills CLI writes for a fetched source says the source is not a path.
    for (const sourceType of [undefined, "", "folder"]) {
      const untyped = await lock({ alpha: { source: "client/private-skills", sourceType } });
      expect(pack(untyped, "skill:alpha")).toEqual({ managedBy: "skills", pack: undefined });
    }
    for (const source of ["jo/agent-skills.v2", "vercel/.github"]) {
      const fetched = await lock({ alpha: { source, sourceType: "github" } });
      expect(pack(fetched, "skill:alpha")).toEqual({ managedBy: "skills", pack: source });
    }
    for (const source of ["./skills", "jo/.", "../skills"]) {
      const dotted = await lock({ alpha: { source, sourceType: "github" } });
      expect(pack(dotted, "skill:alpha")).toEqual({ managedBy: "skills", pack: undefined });
    }

    const fleetrc = async (source: string) =>
      pack(
        await summary({
          ...home,
          "~/.claude/skills/.fleetrc-manifest.json": JSON.stringify({
            version: 1,
            links: { alpha: { source } },
          }),
        }),
        "skill:alpha",
      );
    for (const source of ["~/src/skills", "client/private-skills", "C:\\Users\\jo\\skills", ".."]) {
      expect(await fleetrc(source)).toEqual({ managedBy: "fleetrc", pack: undefined });
    }
    expect(await fleetrc("mine")).toEqual({ managedBy: "fleetrc", pack: "mine" });
  });

  it("names a skill by its frontmatter name, and finds its installer by its folder", async () => {
    const items = await summary({
      ...home,
      "~/.claude/skills/deploy-staging/SKILL.md": skill("deploy", "Deploys."),
      "~/.claude/skills/.fleetrc-manifest.json": JSON.stringify({
        version: 1,
        links: { "deploy-staging": { source: "mine" } },
      }),
    });
    expect(items.find((item) => item.path === "~/.claude/skills/deploy-staging")).toMatchObject({
      id: "skill:deploy",
      managedBy: "fleetrc",
      pack: "mine",
      listed: "- deploy: Deploys.\n".length,
    });
  });

  it("names a skill by its folder when Claude Code refuses its frontmatter name", async () => {
    const items = await summary({
      ...home,
      "~/.claude/skills/deploy/SKILL.md": skill('"deploy  staging"', "Deploys."),
      "~/.claude/skills/ship/SKILL.md": skill("ship\u200bit", "Ships."),
      "~/.claude/skills/review/SKILL.md": skill("code review", "Reviews."),
    });
    const ids = (folder: string) =>
      items.filter((item) => item.path === `~/.claude/skills/${folder}`).map((item) => item.id);
    expect(ids("deploy")).toEqual(["skill:deploy"]);
    expect(ids("ship")).toEqual(["skill:ship"]);
    expect(ids("review")).toEqual(["skill:code review"]);
  });

  it("namespaces an installed plugin without a manifest by its installed name", async () => {
    const bare = "~/.claude/plugins/cache/market/bare/2.0.0";
    const items = await summary({
      ...home,
      "~/.claude/settings.json": JSON.stringify({ enabledPlugins: { "bare@market": true } }),
      "~/.claude/plugins/installed_plugins.json": JSON.stringify({
        version: 2,
        plugins: {
          "bare@market": [
            { scope: "user", installPath: "/home/jo/.claude/plugins/cache/market/bare/2.0.0" },
          ],
        },
      }),
      [`${bare}/skills/how/SKILL.md`]: skill("how", "Explains."),
      // A frontmatter name Claude Code refuses gives way to the folder in a plugin too.
      [`${bare}/skills/deploy/SKILL.md`]: skill('"deploy  staging"', "Deploys."),
      [`${bare}/commands/go.md`]: "---\ndescription: Goes.\n---\nSteps.",
      [`${bare}/agents/helper.md`]: skill("helper", "Helps."),
    });
    expect(
      items.filter((item) => item.scope === "plugin").map((item) => `${item.id} ${item.pack}`),
    ).toEqual(
      ["subagent:bare:helper", "skill:bare:go", "skill:bare:deploy", "skill:bare:how"].map(
        (id) => `${id} bare`,
      ),
    );
  });

  it("applies the skills CLI's lock to skill folders only", async () => {
    const items = await summary({
      ...home,
      "~/.claude/commands/beta.md": "---\ndescription: A command.\n---\nSteps.",
      "~/.claude/agents/.fleetrc-manifest.json": JSON.stringify({
        version: 1,
        links: { rev: { source: "mine" } },
      }),
    });
    const managed = (path: string) => {
      const { managedBy, pack } = items.find((item) => item.path === path)!;
      return { managedBy, pack };
    };
    expect(managed("~/.claude/skills/beta")).toEqual({ managedBy: "skills", pack: "acme/skills" });
    expect(managed("~/.claude/commands/beta.md")).toEqual({ managedBy: "hand", pack: undefined });
    expect(managed("~/.claude/agents/rev.md")).toEqual({ managedBy: "fleetrc", pack: "mine" });
  });

  it("prefers the skills CLI's XDG lock", async () => {
    const items = await summary({
      ...home,
      "~/.local/state/skills/.skill-lock.json": JSON.stringify({
        version: 3,
        skills: { beta: { source: "other/repo", sourceType: "github" } },
      }),
    });
    expect(items.find((item) => item.id === "skill:beta")?.pack).toBe("other/repo");
  });
});

describe("Claude Code machine places", () => {
  const place = (env: Record<string, string>) => ({ home: "/home/jo", env });

  it("reads ~/.claude and ~/.claude.json by default", () => {
    expect(machine.home(place({}))).toBe("/home/jo/.claude");
    expect(machine.roots(place({}))).toEqual(["/home/jo/.claude/projects"]);
    expect(machine.sources(place({}))).toEqual([
      "/home/jo/.claude/CLAUDE.md",
      "/home/jo/.claude/rules",
      "/home/jo/.claude/skills",
      "/home/jo/.claude/commands",
      "/home/jo/.claude/agents",
      "/home/jo/.claude/settings.json",
      "/home/jo/.claude/plugins/installed_plugins.json",
      "/home/jo/.claude/plugins/cache",
      "/home/jo/.claude.json",
      "/home/jo/.agents/.skill-lock.json",
    ]);
  });

  it("follows CLAUDE_CONFIG_DIR, its .claude.json included, and XDG_STATE_HOME", () => {
    const env = { CLAUDE_CONFIG_DIR: "~/work-claude/", XDG_STATE_HOME: "/home/jo/.state" };
    expect(machine.home(place(env))).toBe("/home/jo/work-claude");
    expect(machine.roots(place(env))).toEqual(["/home/jo/work-claude/projects"]);
    const sources = machine.sources(place(env));
    expect(sources).toContain("/home/jo/work-claude/.claude.json");
    expect(sources).toContain("/home/jo/work-claude/skills");
    expect(sources).toContain("/home/jo/.state/skills/.skill-lock.json");
    expect(sources).not.toContain("/home/jo/.claude.json");
    expect(machine.home(place({ CLAUDE_CONFIG_DIR: "alt" }))).toBe("/home/jo/alt");
    expect(machine.home(place({ CLAUDE_CONFIG_DIR: "/srv/claude" }))).toBe("/srv/claude");
  });

  it("inventories a CLAUDE_CONFIG_DIR keyed under the home directory", async () => {
    const items = await summary({
      "~/work-claude/settings.json": "{}",
      "~/work-claude/.claude.json": JSON.stringify({ mcpServers: { a: { command: "a" } } }),
      "~/.claude.json": JSON.stringify({ mcpServers: { b: { command: "b" } } }),
      "~/work-claude/skills/x/SKILL.md": skill("x", "X."),
    });
    expect(items.map((item) => `${item.id} ${item.path}`)).toEqual([
      "skill:x ~/work-claude/skills/x",
      "mcp:a ~/work-claude/.claude.json",
    ]);
  });
});

describe("Claude Code context window", () => {
  const window = machine.contextWindow!;

  it("is 1M when the settings' model ends in [1m], and 200k otherwise", async () => {
    const files = (model?: string) =>
      memoryFiles({
        "~/.claude/settings.json": JSON.stringify(model === undefined ? {} : { model }),
      });
    expect(await window(files("opus[1m]"))).toBe(1_000_000);
    expect(await window(files("claude-sonnet-4-5[1M]"))).toBe(1_000_000);
    expect(await window(files("opus"))).toBe(200_000);
    expect(await window(files())).toBe(200_000);
  });

  it("says nothing when there is no Claude Code config", async () => {
    expect(await window(memoryFiles({}))).toBeUndefined();
  });
});

describe("Claude Code's session ids", () => {
  it("names a main transcript by its session, and a subagent's by its path under the session", () => {
    const projects = "/home/jo/.claude/projects/-home-jo-app";
    const session = "1f2e3d4c-aaaa-bbbb-cccc-0123456789ab";
    expect(machine.sessionId!(`${projects}/${session}.jsonl`)).toBe(session);
    expect(machine.sessionId!(`${projects}/${session}/subagents/agent-a1.jsonl`)).toBe(
      `${session}/subagents/agent-a1.jsonl`,
    );
    expect(machine.sessionId!(`${projects}/${session}/subagents/workflows/w/agent-b.jsonl`)).toBe(
      `${session}/subagents/workflows/w/agent-b.jsonl`,
    );
    expect(machine.sessionId!(`${projects}/${session}/notes.txt`)).toBeUndefined();
  });
});
