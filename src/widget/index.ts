import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import html from "./app.html";

// Hosts cache templates by URI: bump the version whenever app.html changes.
export const WIDGET_URI = "ui://blocket/widget-v3.html";

const IMAGE_ORIGIN = "https://images.blocketcdn.se";

/** Spread into `_meta` of the search, get_ad and price_check tools. MCP Apps key plus the ChatGPT compatibility aliases. */
export const WIDGET_TOOL_META: Record<string, unknown> = {
  ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] },
  "openai/outputTemplate": WIDGET_URI,
  "openai/widgetAccessible": true,
};

export function registerWidget(server: McpServer): void {
  server.registerResource(
    "blocket-widget",
    WIDGET_URI,
    {
      title: "Blocket",
      description: "Blocket search results, ad details, comparisons and price checks.",
      mimeType: "text/html;profile=mcp-app",
    },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: "text/html;profile=mcp-app",
          text: html,
          _meta: {
            ui: { prefersBorder: true, csp: { resourceDomains: [IMAGE_ORIGIN], connectDomains: [] } },
            "openai/widgetPrefersBorder": true,
            "openai/widgetDescription":
              "Shows Blocket ads as cards, ad details with red flags, side-by-side comparisons and asking-price ranges.",
            "openai/widgetCSP": { resource_domains: [IMAGE_ORIGIN], connect_domains: [] },
          },
        },
      ],
    }),
  );
}
