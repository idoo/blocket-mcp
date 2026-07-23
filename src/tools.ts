import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listFilters } from "./blocket/filters.js";
import { search } from "./blocket/search.js";
import { SORTS, VERTICALS } from "./types.js";

export const INSTRUCTIONS = `Read-only access to Blocket.se, Sweden's largest classifieds site, straight from Blocket's own search.
Workflow: search (pick the vertical; Swedish query words work best).
Filters: common ones are typed params; anything else goes in search.filters as Blocket filter name → plain value label (e.g. {"make": "Volvo", "body_type": "Kombi"} or {"length_feet": {"min": 28}}). list_filters shows names and values with live counts. Values that could not be matched come back in "unmatched" with suggestions and were NOT applied: fix them and search again.
Units: SEK, car/mc mileage in Swedish mil (1 mil = 10 km), boat length in feet. near takes coordinates you know for the place.
"What's new since…": search with since (ISO time). For push alerts, give the user blocket_url to save as a search in the Blocket app.
Always link each ad's url. Keep at most 3 calls in parallel.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const vertical = z
  .enum(VERTICALS)
  .describe(
    "torget = general marketplace (furniture, electronics, clothes, kids, hobby, tools...); car, boat, mc (motorcycles), caravan (husvagn), motorhome (husbil), truck (lastbil/släp), tractor, combine (skördetröska), snowmobile, atv, moped (mopeder/scooters), bus.",
  );

const filterParams = {
  query: z.string().min(1).optional().describe("Search words, ideally Swedish ('soffa', 'barnvagn', 'V70', 'Hallberg-Rassy')."),
  places: z
    .array(z.string().min(1))
    .optional()
    .describe("Counties (län) or municipalities, e.g. ['Stockholm'], ['Nacka', 'Värmdö'], ['Västra Götaland']. Omit for all of Sweden."),
  near: z
    .object({
      lat: z.number().min(55).max(70),
      lon: z.number().min(10).max(25),
      radius_km: z.number().positive().max(500),
    })
    .optional()
    .describe("Only ads within radius_km of a point; rows then carry distance_km."),
  price_min: z.number().int().min(0).optional().describe("SEK."),
  price_max: z.number().int().min(0).optional().describe("SEK."),
  year_min: z.number().int().optional().describe("Model year (vehicles)."),
  year_max: z.number().int().optional().describe("Model year (vehicles)."),
  mileage_min_mil: z.number().int().min(0).optional().describe("Swedish mil (1 mil = 10 km)."),
  mileage_max_mil: z.number().int().min(0).optional().describe("Swedish mil (1 mil = 10 km)."),
  seller: z.enum(["private", "dealer"]).optional(),
  trade: z
    .enum(["sale", "giveaway", "wanted"])
    .optional()
    .describe("Torget only: for sale (Säljes), free giveaways (Bortskänkes) or wanted ads (Köpes)."),
  shipping: z.boolean().optional().describe("Torget only: only ads that can be shipped."),
  new_today: z.boolean().optional().describe("Only ads published today."),
  seller_id: z.string().regex(/^\d+$/).optional().describe("Only this seller's ads (seller.id from a row or get_ad)."),
  filters: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.array(z.string()),
        z.object({ min: z.number().optional(), max: z.number().optional() }),
      ]),
    )
    .optional()
    .describe(
      "Vertical-specific filters by Blocket filter name → value label(s) or {min,max}. Examples: car {make: 'Volvo', model: 'V70', fuel: 'Diesel', transmission: 'Automatisk', body_type: 'Kombi', car_equipment: ['Dragkrok']}; boat {class: 'Segelbåt', make: 'Najad', length_feet: {min: 28}}; torget {category: 'Möbler och inredning', condition: 'Mycket bra skick - som ny', brand: 'IKEA'}. Unsure? Call list_filters.",
    ),
};

function result(run: () => Promise<object>) {
  return run().then(
    (data) => ({
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      structuredContent: data as Record<string, unknown>,
    }),
    (error: unknown) => ({
      content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    }),
  );
}

export function registerTools(server: McpServer) {
  server.registerTool(
    "search",
    {
      title: "Search Blocket",
      description:
        "Search live Blocket ads in any vertical with filters, distance and sorting. Returns compact rows (price, place, age, seller, badges, key specs, url, photo), the total count, the filters applied, unmatched filter values with suggestions, optional facets (value counts to refine with) and blocket_url (the same search on blocket.se).",
      inputSchema: {
        vertical: vertical.default("torget"),
        ...filterParams,
        since: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("ISO time: only ads published after it (newest first). Use for 'anything new since…'."),
        sort: z.enum(SORTS).optional().describe("Default relevance. closest needs near; year_*/mileage_* vehicles; length_* boats."),
        page: z.number().int().min(1).max(50).optional(),
        rows: z.number().int().min(1).max(50).optional().describe("Ads per page, default 20."),
        facets: z.boolean().optional().describe("Also return value counts for the main filters (market overview, refining)."),
      },
      annotations: { title: "Search Blocket", ...READ_ONLY },
    },
    (args) => result(() => search(args)),
  );

  server.registerTool(
    "list_filters",
    {
      title: "List Blocket filters",
      description:
        "Filter names and values (with live ad counts) available for a vertical, to use in search.filters. Pass filter to list one filter's values, query to find values by substring (e.g. filter 'make', query 'hallberg').",
      inputSchema: {
        vertical,
        filter: z.string().min(1).optional(),
        query: z.string().min(1).optional(),
      },
      annotations: { title: "List Blocket filters", ...READ_ONLY },
    },
    ({ vertical, filter, query }) => result(() => listFilters(vertical, filter, query)),
  );
}
