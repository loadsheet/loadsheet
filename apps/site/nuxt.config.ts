import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineNuxtConfig } from "nuxt/config";
import viteHubNuxt from "vite-hub/nuxt";
import { writeSchemas } from "./scripts/schema.ts";

const uiFonts = join(
  dirname(fileURLToPath(import.meta.resolve("@loadsheet/ui/styles.css"))),
  "../fonts",
);

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
    name: "loadsheet",
    host: "cloudflare",
    publicUrl: "https://loadsheet.dev",
    console: true,
    health: true,
    comments: false,
    // /api/resolve takes 30 sources a minute per address.
    rateLimit: true,
    // `vitehub deploy` requests these after an upload, with the health route.
    deploy: { check: ["/", "/docs", "/schema/v1.json"] },
  },
  docs: {
    site: { name: "loadsheet", url: "https://loadsheet.dev" },
    comments: false,
  },
  css: ["@loadsheet/ui/styles.css"],
  // Geist and Geist Mono, the variable fonts that stylesheet draws loadsheet's pages in, for every page and the docs'
  // OG images. Left to its provider, @nuxt/fonts would serve static cuts from Google and strip the stylesheet's own.
  fonts: {
    families: [
      { name: "Geist", src: "/fonts/geist.woff2", weight: "100 900", global: true },
      { name: "Geist Mono", src: "/fonts/geist-mono.woff2", weight: "100 900", global: true },
    ],
  },
  nitro: { publicAssets: [{ dir: uiFonts, baseURL: "/fonts", maxAge: 31_536_000 }] },
  // loadsheet's pages and the kit read the theme from `data-theme` on <html>, and Nuxt UI from its class; one stored
  // choice, under the key loadsheet's theme button writes, sets both.
  colorMode: { storageKey: "theme", dataValue: "theme" },
  app: {
    head: {
      htmlAttrs: { lang: "en" },
      title: "loadsheet",
      meta: [
        {
          name: "description",
          content:
            "See what your coding agent reads before you type: the context each skill, instruction file and MCP server costs, and whether any session used it.",
        },
      ],
      // ui-sdk prepends its runtime `<style id="ui-sdk-…">` tags to <head>, which would declare the kit's layer before
      // Preflight's `base` and let `button { font: inherit; color: inherit }` beat its parts. It places them after a
      // style whose id starts with `ui-sdk-`, so this one goes first and fixes the order.
      style: [
        {
          id: "ui-sdk-layer-order",
          textContent: "@layer properties, theme, base, ui-sdk, comark, components, utilities;",
          tagPriority: "critical",
        },
      ],
    },
  },
  $development: {
    vitehub: { console: { auth: false } },
  },
  // @loadsheet/ui ships Vue source, not a build.
  build: { transpile: ["@loadsheet/ui"] },
  routeRules: {
    // A shared Report lives in the URL fragment, so these pages render only in the browser.
    "/report": { ssr: false },
    "/report/**": { ssr: false },
  },
  hooks: {
    // The JSON Schemas at https://loadsheet.dev/schema/*.json, the URLs their `$id`s name.
    // Not under .nuxt, which a fresh build clears after this hook runs.
    "nitro:config"(config) {
      const dir = join(import.meta.dirname, "node_modules/.cache/loadsheet-schema");
      writeSchemas(dir);
      (config.publicAssets ??= []).push({ dir, baseURL: "/schema", maxAge: 300 });
    },
  },
});
