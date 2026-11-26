// Runs the built package in workerd, with no nodejs_compat, for workerd.test.ts.
import { checkMcpToolList, fetchMcpToolList } from "../../dist/index.mjs";

export default {
  async fetch(request) {
    const { list, options, url } = await request.json();
    if (url) return Response.json(await fetchMcpToolList(url));
    return Response.json(checkMcpToolList(list, options));
  },
};
