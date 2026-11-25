// After tsdown: the web UI's build, when there is one, goes into dist/web, where `loadsheet build`
// and `loadsheet --ui` read it. Without apps/web/dist this build of loadsheet has no web UI. The
// JSON Schemas loadsheet.dev serves from schema/ stay behind: a user's report page needs none.
import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url));
const to = fileURLToPath(new URL("../dist/web/", import.meta.url));

if (existsSync(`${from}index.html`)) {
  cpSync(from, to, {
    recursive: true,
    filter: (path) => !path.startsWith(`${from}schema`),
  });
  process.stdout.write("Copied apps/web/dist to dist/web\n");
}
