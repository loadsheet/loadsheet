import { definePackage } from "../../tsdown.shared.ts";

// The bin ships no types: nothing imports it.
export default definePackage({ entry: { cli: "src/cli.ts" }, platform: "node", dts: false });
