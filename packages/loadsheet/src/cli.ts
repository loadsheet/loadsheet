#!/usr/bin/env node
// `loadsheet fleet ...` is fleetrc's CLI, which parses its own flags; anything else is loadsheet's.
const argv = process.argv.slice(2);
const [first, ...rest] = argv;
// After `--` a word is a pack, whatever it looks like.
const options = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;

if (first === "fleet")
  await import("@loadsheet/fleet").then(({ run }) => run(rest, "loadsheet fleet"));
else if (first === "build" || options.includes("--ui"))
  await import("./ui.ts").then(({ run }) => run(argv));
else await import("./main.ts");
