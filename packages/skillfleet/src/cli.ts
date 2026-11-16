#!/usr/bin/env node
import pkg from "../package.json" with { type: "json" };

if (process.argv.includes("--version")) {
  console.log(pkg.version);
} else {
  console.log(`skillfleet ${pkg.version}`);
  console.log("skillfleet is not released yet: https://github.com/onmax/skillfleet");
}
