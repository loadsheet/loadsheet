import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vite-plus/test";
import { routes } from "../src/routes";

const router = (home?: Parameters<typeof routes>[0]) =>
  createRouter({ history: createMemoryHistory(), routes: routes(home) });

describe("the page's routes", () => {
  const r = router();

  it("give a pack in a folder one slug segment per folder", () => {
    const to = r.resolve("/pack/cursor/plugins/pstack");
    expect(to.name).toBe("pack");
    expect(to.params.slug).toEqual(["cursor", "plugins", "pstack"]);
    expect(r.resolve({ name: "pack", params: { slug: ["a", "b"] } }).fullPath).toBe("/pack/a/b");
  });

  it("send older report links to the report, keeping the query", async () => {
    const old = router();
    await old.push("/report/overview?h=codex");
    expect(old.currentRoute.value.fullPath).toBe("/report?h=codex");
    await old.push("/report/skills?h=codex");
    expect(old.currentRoute.value.name).toBe("report");
    expect(old.currentRoute.value.query).toEqual({ h: "codex", view: "table" });
  });

  it("open a page the CLI wrote on its own report", async () => {
    const cli = router({ name: "pack", params: { slug: ["owner", "repo"] } });
    await cli.push("/");
    expect(cli.currentRoute.value.fullPath).toBe("/pack/owner/repo");
  });

  it("name every route the views link to", () => {
    for (const name of ["home", "report", "fixes", "pack"]) expect(r.hasRoute(name)).toBe(true);
  });
});
