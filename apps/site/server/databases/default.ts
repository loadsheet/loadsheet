import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineDatabase } from "vite-hub/database";

/**
  How many scans `/api/mcp` ran each UTC day, by outcome: `scan-url`, `scan-json`, `auth-required` or `error:<code>`.
  A row holds the day, the event and a count, never a URL, host or tool name.
*/
const mcpCounters = sqliteTable(
  "mcp_counters",
  {
    day: text("day").notNull(),
    event: text("event").notNull(),
    n: integer("n").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.day, table.event] })],
);

// The CMS keeps its editor sessions here too. vite-hub needs the D1 id as a literal at build time.
export default defineDatabase({
  schema: { mcpCounters },
  cloudflare: { databaseName: "loadsheet", databaseId: "2c93393c-a40e-4182-a478-ee725fa01ab7" },
});
