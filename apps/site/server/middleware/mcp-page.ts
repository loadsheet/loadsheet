import { defineMiddleware } from "h3";
import { fetchService } from "nitro/services";

/**
  `/mcp` has two readers. MCP clients reach the docs MCP server there, as the server card says, and a browser opening
  the same URL wants the MCP check page. The docs handler owns the route, so a GET that asks for HTML and not an event
  stream is rendered as the page here, before it; every other request passes through unchanged.
*/
export default defineMiddleware((event) => {
  if (event.url.pathname !== "/mcp") return;
  event.res.headers.append("vary", "accept");
  const accept = event.req.headers.get("accept") ?? "";
  const browser =
    (event.req.method === "GET" || event.req.method === "HEAD") &&
    accept.includes("text/html") &&
    !accept.includes("text/event-stream");
  if (browser) return fetchService("ssr", event.req);
});
