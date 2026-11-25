import cms from "vite-hub/cms";
import { defineContent } from "vite-hub/content";
import { docsCollection } from "vite-hub/docs";

// The ViteHub Console edits the docs pages: a save commits to a draft branch of the repository and a
// publish opens a pull request. The pages live in apps/site/content, so the store's root is apps/site.
export default defineContent({
  extends: [cms, { repo: "loadsheet/loadsheet", root: "apps/site", publish: "pr", roles: true }],
  collections: { docs: docsCollection() },
});
