// Platform-neutral MCP request handler shared by the Cloudflare Worker (src/index.ts) and the
// Firebase function (functions/src/index.ts). Stateless: a fresh server and transport per request,
// JSON responses, no sessions. Access control and rate limiting are the caller's job.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { INSTRUCTIONS, registerTools } from "./tools.js";
import { registerWidget } from "./widget/index.js";

export async function handleMcp(request: Request): Promise<Response> {
  const server = new McpServer(
    { name: "blocket", title: "Blocket", version: "2.0.0" },
    { instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  registerTools(server);
  registerWidget(server);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
