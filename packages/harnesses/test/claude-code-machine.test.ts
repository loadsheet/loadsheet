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
      alpha: { target: "/home/jo/.claude/skills/alpha", kind: "skill", source: "onmax/skills" },
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
        pack: "onmax/skills",
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
    expect(items.every((item) => item.description === undefined)).toBe(true);
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

  it("keeps an installer's source out of pack unless it is a plain identifier", async () => {
    const items = await summary({
      ...home,
      "~/.claude/skills/.fleetrc-manifest.json": JSON.stringify({
        version: 1,
        links: { alpha: { source: "~/src/skills" } },
      }),
      "~/.agents/.skill-lock.json": JSON.stringify({
        version: 3,
        skills: {
          beta: { source: "/home/jo/src/beta" },
          gone: { source: "https://jo:sekrit@git.example.com/x.git" },
          quiet: { source: "mine" },
        },
      }),
    });
    const managed = (id: string) => {
      const { managedBy, pack } = items.find((item) => item.id === id)!;
      return { managedBy, pack };
    };
    expect(managed("skill:alpha")).toEqual({ managedBy: "fleetrc", pack: undefined });
    expect(managed("skill:beta")).toEqual({ managedBy: "skills", pack: undefined });
    expect(managed("skill:gone")).toEqual({ managedBy: "skills", pack: undefined });
    expect(managed("skill:quiet")).toEqual({ managedBy: "skills", pack: "mine" });
  });

  it("prefers the skills CLI's XDG lock", async () => {
    const items = await summary({
      ...home,
      "~/.local/state/skills/.skill-lock.json": JSON.stringify({
        version: 3,
        skills: { beta: { source: "other/repo" } },
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
