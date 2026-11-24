// Builds the JSON Schema files from the valibot schemas. generate.ts writes them; the drift test
// compares them with the committed files.
import { toJsonSchema } from "@valibot/to-json-schema";
import type { GenericSchema } from "valibot";
import { ConfigSchema, ReportSchema, ScanSchema } from "../src/schemas.ts";

const build = (schema: GenericSchema, $id: string, title: string): object => {
  // Cross-field checks (bare <= sessions, id matches ref) have no JSON Schema form; parseX enforces them.
  const { $schema, ...rest } = toJsonSchema(schema, {
    target: "draft-07",
    ignoreActions: ["check"],
  });
  return { $schema, $id, title, ...rest };
};

/** Each JSON Schema file, keyed by its file name in `schema/`. */
export const jsonSchemas = (): Record<string, object> => ({
  "report.v1.json": build(ReportSchema, "https://loadsheet.dev/schema/v1.json", "loadsheet Report"),
  "scan.v1.json": build(ScanSchema, "https://loadsheet.dev/schema/scan.v1.json", "loadsheet Scan"),
  "config.v1.json": build(
    ConfigSchema,
    "https://loadsheet.dev/schema/config.v1.json",
    "loadsheet config",
  ),
});
