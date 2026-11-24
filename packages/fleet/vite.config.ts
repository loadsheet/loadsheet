import { defineConfig } from "vite-plus";
import { skillsAgentTable } from "./scripts/agent-table.ts";

// The fleet project of the root config's tests (see ../../vite.config.ts).
export default defineConfig({
  define: skillsAgentTable(),
  test: {
    name: "fleet",
    include: ["test/**/*.test.ts"],
    // Scheduler commands that tests run in-process go to a fake too (test/guard).
    setupFiles: ["test/guard/scheduler-guard.mjs"],
    // End-to-end tests run the built CLI against real git and HTTP.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // On shared CI runners a test that races a detached sync, a timeout or a filesystem watcher
    // can lose to a slow disk now and then. A retry sets up a new machine in a fresh temp folder.
    retry: process.env.CI ? 2 : 0,
  },
});
