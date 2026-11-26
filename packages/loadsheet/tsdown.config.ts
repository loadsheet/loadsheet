import { definePackage } from "../../tsdown.shared.ts";

// The CLI ships no types: nothing imports it.
export default definePackage({
  entry: { cli: "src/cli.ts", "scan-worker": "src/scan-worker.ts" },
  platform: "node",
  dts: false,
});
