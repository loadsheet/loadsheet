import { parseReport, shareableReport, type Report } from "@loadsheet/schema";

/*
  A shared report rides in the URL: `#/report?r=<deflate-raw, base64url>`.
  It carries counters and names only, never a description, and the fragment never reaches a server.
*/
async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  return new Uint8Array(
    await new Response(
      new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream),
    ).arrayBuffer(),
  );
}

export async function shareCode(r: Report) {
  const z = await pipe(
    new TextEncoder().encode(JSON.stringify(shareableReport(r))),
    new CompressionStream("deflate-raw"),
  );
  let bin = "";
  for (const b of z) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function fromShareCode(code: string) {
  const bin = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
  const z = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return parseReport(
    JSON.parse(new TextDecoder().decode(await pipe(z, new DecompressionStream("deflate-raw")))),
  );
}
