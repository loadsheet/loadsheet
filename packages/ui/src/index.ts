// loadsheet's views and the parts they are made of. The host installs `createLoadsheet()`, registers the routes
// `home`, `report` (with `fixes`), and `pack` (a `slug` of one segment per folder), and puts `class="ui-sdk loadsheet"`
// on the element that holds them, with `@loadsheet/ui/styles.css` loaded.
export { default as Landing } from "./views/Landing.vue";
export { default as ReportShell } from "./views/ReportShell.vue";
export { default as Report } from "./views/Report.vue";
export { default as Fixes } from "./views/Fixes.vue";
export { default as Pack } from "./views/Pack.vue";
export { default as NotFound } from "./views/NotFound.vue";
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
