import { parseReport, type Report } from "@loadsheet/schema";
import { type App, type InjectionKey, type ShallowRef, inject, shallowRef } from "vue";
import {
  type Pack,
  type ShareForm,
  bundledPacks,
  exampleReport,
  packRoute,
  packSlug,
} from "./report";
import { fromShareCode } from "./share";

/**
  The report on screen and where it came from. The host app makes one with `createLoadsheet` and installs it, and the
  views read it with `useLoadsheet`, so nothing here is module state: each app, and each server render, has its own.
*/
export interface Loadsheet {
  report: ShallowRef<Report>;
  /** True while the report on screen is the bundled example. */
  isExample: ShallowRef<boolean>;
  /** True while the report on screen came from a shared link. */
  shared: ShallowRef<boolean>;
  /** Set when the URL carried a report this page couldn't read, so the page can say so instead of showing the example. */
  linkError: ShallowRef<string | undefined>;
  /** The packs the pack page can show without a server, by `owner/repo[/dir]`. */
  packs: Record<string, Pack>;
  /** The page a share link opens on, such as `https://loadsheet.dev/`. */
  shareBase: () => string;
  /** How a share link addresses that page. */
  shareForm: ShareForm;
  /** Reads a report.json the user dropped or picked. Throws a SchemaError with every issue's path. */
  openFile: (file: File) => Promise<void>;
  /** Opens the report a share code carries, or sets `linkError` when it can't be read. */
  openShareCode: (code: string) => Promise<void>;
  install: (app: App) => void;
}

export const LOADSHEET = Symbol("loadsheet") as InjectionKey<Loadsheet>;

export interface LoadsheetOptions {
  /** The report to show; the example when there is none. */
  report?: Report;
  /** Packs beside the bundled ones, such as the one the CLI inlined. */
  packs?: Record<string, Pack>;
  shareBase: () => string;
  /** @default "hash" */
  shareForm?: ShareForm;
}

export function createLoadsheet(options: LoadsheetOptions): Loadsheet {
  const state: Loadsheet = {
    report: shallowRef(options.report ?? exampleReport),
    isExample: shallowRef(!options.report),
    shared: shallowRef(false),
    linkError: shallowRef(),
    packs: { ...bundledPacks, ...options.packs },
    shareBase: options.shareBase,
    shareForm: options.shareForm ?? "hash",
    async openFile(file) {
      state.report.value = parseReport(JSON.parse(await file.text()));
      state.isExample.value = false;
      state.shared.value = false;
      state.linkError.value = undefined;
    },
    async openShareCode(code) {
      try {
        state.report.value = await fromShareCode(code);
        state.isExample.value = false;
        state.shared.value = true;
      } catch (e) {
        state.linkError.value = e instanceof Error ? e.message : String(e);
      }
    },
    install: (app) => void app.provide(LOADSHEET, state),
  };
  return state;
}

export function useLoadsheet(): Loadsheet {
  const state = inject(LOADSHEET);
  if (!state) throw new Error("loadsheet's views need createLoadsheet() installed in the app");
  return state;
}

/**
  Where a page the CLI wrote opens: the user's own report, or the pack it read, which it names by its source so the
  route reads `owner/repo[/dir]`.
*/
export function cliHome(r: Report): {
  route: ReturnType<typeof packRoute> | { name: "report" };
  packs?: Record<string, Pack>;
} {
  if (r.mode !== "pack") return { route: { name: "report" } };
  // A folder's name goes into the route, where `#`, `?` or `%` would change what it reads.
  const slug =
    packSlug(r.source ?? "") ??
    r.source
      ?.split(/[\\/]/)
      .filter(Boolean)
      .at(-1)
      ?.replace(/[^\w.-]+/g, "-") ??
    "pack";
  return {
    route: packRoute(slug),
    packs: { [slug]: { report: r, title: slug.split("/").at(-1)! } },
  };
}

/** `loadsheet --ui` and `loadsheet build` inline the report as `<script type="application/json" id="report">`. */
export function inlinedReport(doc: Document): Report | undefined {
  const el = doc.getElementById("report");
  return el?.textContent ? parseReport(JSON.parse(el.textContent)) : undefined;
}
