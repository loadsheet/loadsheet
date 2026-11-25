import { join } from "node:path";
import { defineNuxtConfig } from "nuxt/config";
import viteHubNuxt from "vite-hub/nuxt";
import { writeSchemas } from "./scripts/schema.ts";

// A staging build deploys as the Worker loadsheet-next on its workers.dev URL, so it names no public URL.
const staging = process.env.LOADSHEET_STAGING === "1";

export default defineNuxtConfig({
  compatibilityDate: "2026-11-01",
  modules: [
    "@nuxt/ui",
    "@ui-sdk/vue/nuxt",
    "@vite-hub/kit/nuxt",
    viteHubNuxt,
    "vite-hub/docs/nuxt",
  ],
  vitehub: {
    name: staging ? "loadsheet-next" : "loadsheet",
    host: "cloudflare",
    ...(staging ? {} : { publicUrl: "https://loadsheet.dev" }),
    console: true,
    health: true,
    comments: false,
    // `vitehub deploy` requests these after an upload, with the health route.
    deploy: { check: ["/", "/docs", "/schema/v1.json"] },
  },
  docs: {
    site: { name: "loadsheet", url: "https://loadsheet.dev" },
    comments: false,
  },
  $development: {
    vitehub: { console: { auth: false } },
  },
  // @loadsheet/ui ships Vue source, not a build.
  build: { transpile: ["@loadsheet/ui"] },
  routeRules: {
    // A shared Report lives in the URL fragment, so these pages render only in the browser.
    "/report/**": { ssr: false },
  },
  hooks: {
    // The JSON Schemas at https://loadsheet.dev/schema/*.json, the URLs their `$id`s name.
    "nitro:config"(config) {
      const dir = join(import.meta.dirname, ".nuxt/schema");
      writeSchemas(dir);
      (config.publicAssets ??= []).push({ dir, baseURL: "/schema", maxAge: 300 });
    },
  },
});
