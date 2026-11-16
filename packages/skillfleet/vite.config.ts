import { defineConfig } from "vite-plus";

export default defineConfig({
  // ESM only, for Node, and publint fails the build on a broken package.json.
  pack: {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    platform: "node",
    fixedExtension: true,
    clean: true,
    publint: true,
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: { ignorePatterns: ["**/dist/**"] },
  lint: {
    ignorePatterns: ["**/dist/**"],
    options: { typeAware: true, typeCheck: false },
  },
});
