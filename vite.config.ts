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

export default defineConfig({
  run: {
    tasks: {
      "packages:build": {
        command: 'pnpm -r --filter "./packages/*" run build',
        cache: {
          input: [
            "packages/*/src/**",
            "packages/*/package.json",
            "packages/*/tsdown.config.ts",
            "packages/fleet/scripts/agent-table.ts",
            "packages/loadsheet/scripts/copy-web.ts",
            "apps/web/dist/**",
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
          output: ["packages/*/dist/**"],
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
    ],
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: { ignorePatterns: ["**/dist/**"] },
  lint: {
    ignorePatterns: ["**/dist/**"],
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
    ],
  },
});
