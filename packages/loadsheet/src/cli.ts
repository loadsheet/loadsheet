#!/usr/bin/env node
// `loadsheet fleet ...` is fleetrc's CLI, which parses its own flags; anything else is loadsheet's.
const [first, ...rest] = process.argv.slice(2);
if (first === "fleet")
  await import("@loadsheet/fleet").then(({ run }) => run(rest, "loadsheet fleet"));
else if (first === "build" || process.argv.includes("--ui"))
  await import("./ui.ts").then(({ run }) => run(process.argv.slice(2)));
else await import("./main.ts");
