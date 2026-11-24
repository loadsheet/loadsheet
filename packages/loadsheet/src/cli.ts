#!/usr/bin/env node
// `loadsheet fleet ...` is fleetrc's CLI, which parses its own flags; anything else is loadsheet's.
const [first, ...rest] = process.argv.slice(2);
if (first === "fleet")
  await import("@loadsheet/fleet").then(({ run }) => run(rest, "loadsheet fleet"));
else await import("./main.ts");
