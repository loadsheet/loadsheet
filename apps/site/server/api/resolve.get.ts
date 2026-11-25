import { type ResolveErrorCode, ResolveError, resolvePack } from "@loadsheet/resolve";
import { HTTPError, defineHandler, getQuery, getRequestIP } from "h3";
import { requireRateLimit } from "vite-hub/rate-limit";

const STATUS: Record<ResolveErrorCode, number> = {
  "unsupported-source": 400,
  "not-found": 404,
  "no-skills": 404,
  "too-large": 413,
  timeout: 504,
};

/**
  `GET /api/resolve?source=owner/repo`: a public GitHub skills source weighed as a pack Report. It reads public
  repositories only, takes no token and stores nothing; a local path, `file:` or `ssh:` source is refused before any fetch.
*/
export default defineHandler(async (event) => {
  const { source } = getQuery(event);
  if (typeof source !== "string" || !source.trim() || source.length > 300)
    throw new HTTPError({
      status: 400,
      message: "Pass one source, such as ?source=owner/repo",
      data: { code: "unsupported-source" },
    });
  // Per address. The pack page's server render calls this route in-process, with the visitor's headers on an event
  // that carries no Cloudflare bindings. Given only the headers, the guard reads the bindings of the Worker request
  // that runs, and takes the key it is given.
  const key =
    event.req.headers.get("cf-connecting-ip") ??
    getRequestIP(event, { xForwardedFor: true }) ??
    "unknown";
  await requireRateLimit({ headers: event.req.headers }, "resolve", {
    key,
    limit: 30,
    window: "1m",
  });
  try {
    const report = await resolvePack(source, {
      signal: AbortSignal.timeout(10_000),
      maxBytes: 32 * 1024 * 1024,
    });
    event.res.headers.set("cache-control", "public, max-age=300");
    return report;
  } catch (error) {
    if (!(error instanceof ResolveError)) throw error;
    throw new HTTPError({
      status: STATUS[error.code],
      message: error.message,
      data: { code: error.code },
    });
  }
});
