#!/usr/bin/env node
import pkg from "../package.json" with { type: "json" };

if (process.argv.includes("--version")) {
  console.log(pkg.version);
} else {
  console.log(`skync ${pkg.version}`);
  console.log("skync is not released yet: https://github.com/onmax/skync");
}
