/**
  loadsheet.dev was one page with a hash router, so old links read `/#/report?h=codex&r=<code>`, `/#/report/fixes` or
  `/#/pack/owner/repo`. Each becomes its own path, with the report still in the fragment: `/report?h=codex#r=<code>`.
*/
const OLD_REPORT_VIEWS: Record<string, string> = {
  "/report/overview": "/report",
  "/report/map": "/report",
  "/report/list": "/report?view=table",
  "/report/skills": "/report?view=table",
};

export function legacyTarget(hash: string): string | undefined {
  if (!hash.startsWith("#/")) return undefined;
  const [route = "/", query = ""] = hash.slice(1).split("?");
  const params = new URLSearchParams(query);
  const code = params.get("r");
  params.delete("r");
  const [path = "/", fixed = ""] = (OLD_REPORT_VIEWS[route] ?? route).split("?");
  for (const [k, v] of new URLSearchParams(fixed)) params.set(k, v);
  const search = params.toString();
  return `${path}${search ? `?${search}` : ""}${code ? `#r=${code}` : ""}`;
}

export default defineNuxtPlugin({
  name: "legacy-hash",
  enforce: "pre",
  async setup() {
    const target = legacyTarget(location.hash);
    if (!target) return;
    location.replace(target);
    // The page is going away: render nothing under the old address.
    await new Promise(() => {});
  },
});
