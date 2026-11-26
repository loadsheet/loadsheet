// End-to-end check of a running loadsheet.dev: `node apps/site/test/e2e.mjs http://localhost:4384`.
// The legacy-link check drives Chromium through Playwright; set PLAYWRIGHT to its module path and
// CHROMIUM to a browser binary when they aren't installed where Node can find them.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { parseReport, shareableReport } from "@loadsheet/schema";

const base = (process.argv[2] ?? "http://localhost:4384").replace(/\/+$/, "");
const PACK = "mattpocock/skills";
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error.message.split("\n").join("\n     ")}`);
  }
}

// Pages are asked for as a browser does, so an error comes back as a page; /api as a script does, so it comes as JSON.
const get = (path) =>
  fetch(`${base}${path}`, {
    redirect: "manual",
    headers: { accept: path.startsWith("/api/") ? "application/json" : "text/html" },
  });
const escapeHtml = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
/** The HTML the server sent, up to its first script: what a reader sees before any JavaScript runs. */
// The markup alone, so a check can't pass on the Nuxt payload or another script's text.
const withoutScripts = (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");

async function shareCode(report) {
  const json = new TextEncoder().encode(JSON.stringify(shareableReport(report)));
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return Buffer.from(await new Response(stream).arrayBuffer()).toString("base64url");
}

let pack;
await check("/api/resolve answers a pack Report that parseReport accepts", async () => {
  const res = await get(`/api/resolve?source=${encodeURIComponent(PACK)}`);
  const text = await res.text();
  assert.equal(res.status, 200, `status ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  assert.equal(body.mode, "pack");
  pack = parseReport(body);
  assert.ok(pack.sheet[0].lines.length > 0, "the pack has no lines");
});

await check(`/pack/${PACK} markup holds each skill's name and description`, async () => {
  assert.ok(pack, "no pack from /api/resolve");
  const res = await get(`/pack/${PACK}`);
  assert.equal(res.status, 200);
  const html = withoutScripts(await res.text());
  const skills = pack.sheet[0].lines.filter((l) => l.ref.kind === "skill" && l.description);
  assert.ok(skills.length > 0, "the pack lists no skill with a description");
  for (const l of skills) {
    assert.ok(html.includes(escapeHtml(l.ref.name)), `missing skill name ${l.ref.name}`);
    // The table shows each description's first sentence; the rest opens on click.
    const first = l.description.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? l.description;
    assert.ok(html.includes(escapeHtml(first)), `missing description of ${l.ref.name}: ${first}`);
  }
});

for (const source of ["/etc", "file:///etc", "git@github.com:a/b", "ssh://git@github.com/a/b"]) {
  await check(`/api/resolve refuses ${source} with 400`, async () => {
    const res = await get(`/api/resolve?source=${encodeURIComponent(source)}`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.data?.code, "unsupported-source", JSON.stringify(body));
  });
}

await check("/report HTML holds no Report data", async () => {
  const res = await get("/report");
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const marker of ['"sheet"', '"findings"', '"harness"', "used before you type"])
    assert.ok(!html.includes(marker), `found ${marker}`);
});

await check("a made-up path answers 404", async () => {
  const res = await get("/no-such-page-here");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /loadsheet has no page here/);
});

for (const name of ["v1.json", "scan.v1.json", "config.v1.json"]) {
  await check(`/schema/${name} serves the schema its $id names`, async () => {
    const res = await fetch(`${base}/schema/${name}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).$id, `https://loadsheet.dev/schema/${name}`);
  });
}

await check("/docs answers 200 with the docs theme, not loadsheet's layout", async () => {
  const res = await get("/docs");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes("ui-sdk loadsheet"), "docs render inside the loadsheet layout");
});

await check("a legacy #/report?r= link lands on /report#r= and renders it", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
  const example = parseReport(
    JSON.parse(
      await readFile(new URL("../../../examples/report.example.json", import.meta.url), "utf8"),
    ),
  );
  const code = await shareCode(example);
  const browser = await chromium.launch(
    process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
  );
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/#/report?r=${code}`);
    await page.waitForURL((u) => u.pathname === "/report", { timeout: 15_000 });
    assert.equal(new URL(page.url()).hash, `#r=${code}`);
    await page.getByText("used before you type").waitFor({ timeout: 15_000 });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
