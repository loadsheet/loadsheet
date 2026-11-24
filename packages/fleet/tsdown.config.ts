import { definePackage } from "../../tsdown.shared.ts";
import { skillsAgentTable } from "./scripts/agent-table.ts";

// Every dependency is bundled, so dist/cli.mjs runs on its own: self-install copies dist/ into the
// state folder, away from node_modules, for the timer and the hooks to run.
export default definePackage({
  entry: { index: "src/index.ts", cli: "src/entry.ts" },
  platform: "node",
  define: skillsAgentTable(),
  deps: {
    alwaysBundle: ["skills", "@vite-hub/schedule"],
    onlyBundle: [
      "skills",
      "yaml",
      "nostics",
      "tar",
      "@vite-hub/schedule",
      "@vite-hub/runtime",
      "cron-schedule",
      "jsonc-parser",
      "smol-toml",
      "fastest-levenshtein",
    ],
  },
});
