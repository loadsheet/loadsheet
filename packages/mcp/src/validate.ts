import { validate as draft07 } from "./generated/draft07.js";
import { validate as draft2020 } from "./generated/draft2020.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** Meta-schema errors against draft 2020-12, as `pointer message` lines; empty when valid. */
export function draft2020Errors(schema: unknown): string[] {
  return errors(draft2020, schema);
}

/** Meta-schema errors against draft-07, as `pointer message` lines; empty when valid. */
export function draft07Errors(schema: unknown): string[] {
  return errors(draft07, schema);
}

/** Whether `$schema` is absent or names draft 2020-12. */
export function declaresDraft2020OrNothing(schema: { $schema?: unknown }): boolean {
  if (schema.$schema === undefined) return true;
  return typeof schema.$schema === "string" && schema.$schema.replace(/#$/, "") === DRAFT_2020_12;
}

function errors(validate: typeof draft2020, schema: unknown): string[] {
  if (validate(schema)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}
