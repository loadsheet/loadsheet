import { defineDatabase } from "vite-hub/database";

// The CMS keeps its editor sessions here. vite-hub needs the D1 id as a literal at build time.
export default defineDatabase({
  schema: {},
  cloudflare: { databaseName: "loadsheet", databaseId: "2c93393c-a40e-4182-a478-ee725fa01ab7" },
});
