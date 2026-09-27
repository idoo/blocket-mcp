// Firebase (Cloud Functions 2nd gen) entry point for the same MCP server the Cloudflare Worker runs.
// The endpoint is <function URL>/<MCP_PATH_TOKEN>: the unguessable path is the access control, as on
// the Worker. Firebase has no rate-limit binding, so maxInstances × concurrency is the cost cap.

import { onRequest } from "firebase-functions/https";
import { defineSecret } from "firebase-functions/params";
import { handleMcp } from "../../src/mcp.js";

const MCP_PATH_TOKEN = defineSecret("MCP_PATH_TOKEN");

// Hop-by-hop or length headers that must not be forwarded into a re-built Request/Response.
const SKIP_HEADERS: Record<string, true> = {
  connection: true,
  "keep-alive": true,
  "transfer-encoding": true,
  "content-length": true,
  upgrade: true,
};

export const mcp = onRequest(
  {
    region: "europe-north1",
    secrets: [MCP_PATH_TOKEN],
    invoker: "public",
    maxInstances: 3,
    concurrency: 20,
    cpu: 1,
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  async (req, res) => {
    // req.path is relative to the function: <function URL>/<token> arrives as /<token> on
    // cloudfunctions.net and in the emulator (which strips /<project>/<region>/mcp); /mcp/<token> is
    // also accepted so a run.app URL or a Hosting rewrite can mirror the Worker's /mcp/<token> path.
    const token = MCP_PATH_TOKEN.value();
    if (!token || (req.path !== `/${token}` && req.path !== `/mcp/${token}`)) {
      res.status(404).send("Not found");
      return;
    }
    // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
    if (req.method !== "POST") {
      res.status(405).set("allow", "POST").send("Method not allowed");
      return;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || Object.hasOwn(SKIP_HEADERS, name)) continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    }
    const request = new Request(`https://${req.headers.host ?? "localhost"}${req.originalUrl}`, {
      method: req.method,
      headers,
      body: req.rawBody?.length ? new Uint8Array(req.rawBody) : undefined,
    });

    const response = await handleMcp(request);
    res.status(response.status);
    response.headers.forEach((value, name) => {
      if (!Object.hasOwn(SKIP_HEADERS, name)) res.append(name, value);
    });
    res.send(Buffer.from(await response.arrayBuffer()));
  },
);
