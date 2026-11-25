import { builtinModules } from "node:module";
import { defineConfig } from "vite-plus";

// schema and core run in the browser too, so they import no Node builtin and none of the Node-side packages.
const message = "schema and core are isomorphic: no Node builtins, kit, harnesses or loadsheet.";
const isomorphicImports = {
  paths: [...builtinModules, "@loadsheet/kit", "@loadsheet/harnesses", "loadsheet"].map((name) => ({
    name,
    message,
  })),
  patterns: [
    { group: ["node:*", "@loadsheet/kit/*", "@loadsheet/harnesses/*", "loadsheet/*"], message },
    // A relative path into a sibling package gets past the names above.
    { regex: "\\.\\./(.*/)?(kit|harnesses|loadsheet)(/|$)", message },
  ],
};

// harnesses and kit's main entry run in the browser too; kit's Node readers live in `@loadsheet/kit/node`.
const nodeMessage =
  "harnesses and kit's main entry are isomorphic: no Node builtins or @loadsheet/kit/node.";
const nodeFreeImports = {
  paths: [...builtinModules, "@loadsheet/kit/node"].map((name) => ({ name, message: nodeMessage })),
  patterns: [
    { group: ["node:*"], message: nodeMessage },
    // A relative path into kit's node folder gets past the names above.
    { regex: "^\\.\\.?/(.*/)?node(/|$)", message: nodeMessage },
  ],
};

// What `nuxt build` and `wrangler dev` write in apps/site.
const nuxtOutput = [
  "apps/site/.nuxt/**",
  "apps/site/.output/**",
  "apps/site/.vitehub/**",
  "apps/site/.wrangler/**",
];

// resolve runs in a Cloudflare Worker too: no git, no child processes, and no CLI or fleet.
const workerMessage =
  "resolve runs in a Cloudflare Worker: no child processes, git, loadsheet or @loadsheet/fleet.";
const workerImports = {
  paths: ["child_process", "node:child_process", "simple-git", "loadsheet", "@loadsheet/fleet"].map(
    (name) => ({ name, message: workerMessage }),
  ),
  patterns: [{ group: ["loadsheet/*", "@loadsheet/fleet/*"], message: workerMessage }],
};

export default defineConfig({
  run: {
    tasks: {
      "packages:build": {
        // The web UI builds first: `loadsheet` copies its page into dist/web.
        command: 'pnpm -r --filter "./packages/*" --filter @loadsheet/web run build',
        cache: {
          input: [
            "packages/*/src/**",
            "packages/schema/schema/**",
            "packages/*/package.json",
            "packages/*/tsdown.config.ts",
            "packages/fleet/scripts/agent-table.ts",
            "packages/loadsheet/scripts/copy-web.ts",
            "apps/web/src/**",
            "apps/web/index.html",
            "apps/web/package.json",
            "apps/web/vite.config.ts",
            "packages/*/README.md",
            "packages/*/LICENSE",
            "tsdown.shared.ts",
            "tsconfig.json",
            "package.json",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            ".node-version",
            "vite.config.ts",
          ],
          output: ["packages/*/dist/**", "apps/web/dist/**"],
          env: ["NODE_ENV"],
        },
      },
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "packages",
          include: ["packages/*/test/**/*.test.ts"],
          // fleet runs as its own project, with its own setup and timeouts.
          exclude: ["**/node_modules/**", "packages/fleet/**"],
        },
      },
      "packages/fleet",
      // The web app's own tests, with its aliases to the workspace sources.
      "apps/web",
    ],
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: { ignorePatterns: ["**/dist/**", ...nuxtOutput] },
  lint: {
    ignorePatterns: ["**/dist/**", ...nuxtOutput],
    options: { typeAware: true, typeCheck: false },
    overrides: [
      {
        files: ["packages/core/src/**", "packages/schema/src/**"],
        rules: { "no-restricted-imports": ["error", isomorphicImports] },
      },
      {
        files: ["packages/harnesses/src/**", "packages/kit/src/**"],
        rules: { "no-restricted-imports": ["error", nodeFreeImports] },
      },
      {
        files: ["packages/kit/src/node/**"],
        rules: { "no-restricted-imports": "off" },
      },
      {
        files: ["packages/resolve/src/**"],
        rules: { "no-restricted-imports": ["error", workerImports] },
      },
    ],
  },
});
