import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite-plus";

// The ui project of the root config's tests (see ../../vite.config.ts), reading the contract from source.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@loadsheet/schema": fileURLToPath(new URL("../schema/src/index.ts", import.meta.url)),
      "@loadsheet/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: { name: "ui", include: ["test/**/*.test.ts"] },
});
