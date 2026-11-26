#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// `loadsheet fleet ...` is fleetrc's CLI, which parses its own flags; anything else is loadsheet's.
const argv = process.argv.slice(2);
const [first, ...rest] = argv;
// After `--` a word is a pack, whatever it looks like.
const options = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;

// V8's compiled code for loadsheet's own modules, kept beside the scan cache so a later run starts
// sooner. The directory is kit's `defaultCacheDir`, spelled out here so kit is not loaded before
// the compile cache is on; a test holds the two together.
if (!options.includes("--no-cache")) {
  try {
    const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "loadsheet");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    enableCompileCache(join(dir, "compile"));
  } catch {
    // The compile cache only saves time.
  }
}

if (first === "fleet")
  await import("@loadsheet/fleet").then(({ run }) => run(rest, "loadsheet fleet"));
else if (first === "build" || options.includes("--ui"))
  await import("./ui.ts").then(({ run }) => run(argv));
else await import("./main.ts");
