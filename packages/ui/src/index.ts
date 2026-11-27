// loadsheet's views and the parts they are made of. The host installs `createLoadsheet()`, registers the routes
// `home`, `report` (with `fixes`), and `pack` (a `slug` of one segment per folder), and puts `class="ui-sdk loadsheet"`
// on the element that holds them, with `@loadsheet/ui/styles.css` loaded. A host with a server for `POST /api/mcp`
// also registers `mcp` for the MCP check, and the site header links to it. A host that serves the skill pack reviews
// registers `skills`, `skill-pack` (a `slug` like `pack`) and `skill-compare` (a `job`), and the header links to them.
export { default as Landing } from "./views/Landing.vue";
export { default as ReportShell } from "./views/ReportShell.vue";
export { default as Report } from "./views/Report.vue";
export { default as Fixes } from "./views/Fixes.vue";
export { default as Pack } from "./views/Pack.vue";
export { default as NotFound } from "./views/NotFound.vue";
export { default as Mcp } from "./views/Mcp.vue";
export { default as Skills } from "./views/Skills.vue";
export { default as SkillPack } from "./views/SkillPack.vue";
export { default as SkillCompare } from "./views/SkillCompare.vue";
export { default as Overlays } from "./components/Overlays.vue";
export { default as StateBox } from "./components/StateBox.vue";
export {
  type Loadsheet,
  type LoadsheetOptions,
  LOADSHEET,
  cliHome,
  createLoadsheet,
  inlinedReport,
  useLoadsheet,
} from "./lib/state";
export {
  type Pack as PackEntry,
  type PackError,
  type ShareForm,
  bundledPacks,
  exampleReport,
  packRoute,
  packSlug,
  shareLink,
} from "./lib/report";
export { fromShareCode, shareCode } from "./lib/share";
export { type McpCheck, type McpCheckError, mcpUrl, shortUrl } from "./lib/mcp";
export {
  type SkillCatalog,
  type SkillFiles,
  type SkillPack as SkillPackEntry,
  BUDGET,
  packTotals,
  skillPackRoute,
} from "./lib/skills";
