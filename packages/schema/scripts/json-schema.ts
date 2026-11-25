// Builds the JSON Schema files from the valibot schemas. generate.ts writes them; the drift test
// compares them with the committed files.
import { toJsonSchema } from "@valibot/to-json-schema";
import type { GenericSchema } from "valibot";
import { ConfigSchema, ReportSchema, ScanSchema } from "../src/schemas.ts";

type Node = { [key: string]: unknown };

const build = (schema: GenericSchema, $id: string, title: string): Node => {
  // Checks are not converted. Counter checks (bare <= sessions, id matches ref) have no JSON
  // Schema form and only parseX enforces them; the conditions below are written out by hand.
  const { $schema, ...rest } = toJsonSchema(schema, {
    target: "draft-07",
    ignoreActions: ["check"],
  });
  return { $schema, $id, title, ...rest };
};

const at = (node: Node, ...keys: string[]): Node =>
  keys.reduce((inner, key) => inner[key] as Node, node);
const each = (properties: Node): Node => ({
  type: "array",
  items: { type: "object", properties },
});
const emptyArray = { type: "array", maxItems: 0 };

const scan = (): Node =>
  build(ScanSchema, "https://loadsheet.dev/schema/scan.v1.json", "loadsheet Scan");

// A set or hide-from-model fix says what to set or run. Outside pack mode every fix names its
// machine.
const report = (): Node => {
  const schema = build(ReportSchema, "https://loadsheet.dev/schema/v1.json", "loadsheet Report");
  const fix = at(schema, "properties", "findings", "items", "properties", "fixes", "items");
  fix.anyOf = [
    { not: { properties: { action: { enum: ["set", "hide-from-model"] } } } },
    { required: ["set"] },
    { required: ["run"] },
  ];
  schema.if = { properties: { mode: { const: "pack" } }, required: ["mode"] };
  schema.then = {
    properties: {
      machines: emptyArray,
      coverage: emptyArray,
      sheet: each({ lines: each({ machines: emptyArray }) }),
      findings: each({ where: emptyArray, fixes: each({ machine: false }) }),
    },
  };
  schema.else = {
    properties: {
      findings: each({
        fixes: { type: "array", items: { type: "object", required: ["machine"] } },
      }),
    },
  };
  return schema;
};

/** Each JSON Schema file, keyed by its file name in `schema/`. */
export const jsonSchemas = (): Record<string, object> => ({
  "report.v1.json": report(),
  "scan.v1.json": scan(),
  "config.v1.json": build(
    ConfigSchema,
    "https://loadsheet.dev/schema/config.v1.json",
    "loadsheet config",
  ),
});
