import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite-plus";

/**
 * Folds the entry script and the stylesheet into index.html, so the built page is one file that opens by
 * double-click: Chromium won't load a module script from file://, but it runs one written inline.
 */
function singleFile() {
  return {
    name: "loadsheet:single-file",
    enforce: "post" as const,
    generateBundle(_: unknown, bundle: Record<string, any>) {
      const page = bundle["index.html"];
      if (page?.type !== "asset") return;
      let html = String(page.source);
      for (const [name, file] of Object.entries(bundle)) {
        const tag = new RegExp(
          `<(script|link)[^>]*?(src|href)="[^"]*${name.replace(/[.]/g, "\\.")}"[^>]*>(</script>)?`,
        );
        if (file.type === "chunk" && file.isEntry) {
          html = html.replace(
            tag,
            () =>
              `<script type="module">${file.code.replaceAll("</script", "<\\/script")}</script>`,
          );
        } else if (file.type === "asset" && name.endsWith(".css")) {
          html = html.replace(tag, () => `<style>${String(file.source)}</style>`);
        } else continue;
        delete bundle[name];
      }
      page.source = html;
    },
  };
}

export default defineConfig({
  // Relative paths, so the page works from whatever folder `loadsheet build` copies it into.
  base: "./",
  plugins: [vue(), singleFile()],
  resolve: {
    // Read the contract from source so the app needs no package build.
    alias: {
      "@loadsheet/schema": fileURLToPath(
        new URL("../../packages/schema/src/index.ts", import.meta.url),
      ),
    },
  },
  // Fonts inline as data URIs and the CSS stays one sheet, so singleFile leaves nothing behind in assets/.
  build: { assetsInlineLimit: 1_000_000, cssCodeSplit: false },
});
