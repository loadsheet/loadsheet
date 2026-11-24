#!/usr/bin/env node
// The fleetrc bin: @loadsheet/fleet's CLI under the name fleetrc. It checks the Node version before
// that bundle loads, since an older Node fails to parse it with a SyntaxError that names no version.
// Keep this file to syntax old versions read: no top-level await. MAJOR.MINOR matches `engines`.
const [MAJOR, MINOR] = [22, 12];
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < MAJOR || (major === MAJOR && minor < MINOR)) {
  console.error(
    `fleetrc needs Node.js ${MAJOR}.${MINOR} or newer, and this is Node.js ${process.versions.node} (${process.execPath}).`,
  );
  process.exit(1);
}
void import("@loadsheet/fleet").then(({ run }) => run(process.argv.slice(2), "fleetrc"));
