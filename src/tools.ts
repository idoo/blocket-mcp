import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAds } from "./blocket/ad.js";
import { listFilters } from "./blocket/filters.js";
import { getAdPhotos } from "./blocket/photos.js";
import { priceCheck } from "./blocket/price.js";
import { search } from "./blocket/search.js";
import { SORTS, VERTICALS } from "./types.js";
import { WIDGET_TOOL_META } from "./widget/index.js";

export const INSTRUCTIONS = `Read-only access to Blocket.se, Sweden's largest classifieds site, straight from Blocket's own search.
Workflow: search (pick the vertical; Swedish query words work best) → get_ad for description, specs, photos, seller and red flags (2-5 ids = side-by-side comparison) → price_check to judge an asking price against comparable live ads. get_ad_photos shows an ad's photos as images.
Filters: common ones are typed params; anything else goes in search.filters as Blocket filter name → plain value label (e.g. {"make": "Volvo", "body_type": "Kombi"} or {"length_feet": {"min": 28}}). list_filters shows names and values with live counts. Values that could not be matched come back in "unmatched" with suggestions and were NOT applied: fix them and search again.
Relevance: query takes Blocket operators (-word, a OR b, "exact phrase", word*). exclude drops rows with accessory words (e.g. ['skal', 'laddare', 'köpes']), require keeps rows with all words, title_only needs every query word in the title; continue with next_page.
Deals: deals (or sort "deal") labels rows great/good/fair/high against the median asking price of the same search (deal_basis). risk_words marks titles like defekt or reservdelar.
Units: SEK, car/mc mileage in Swedish mil (1 mil = 10 km), boat length in feet. near takes coordinates you know for the place.
price_check and deals report asking prices of live ads, never sold prices. red_flags and risk_words are facts to check, not verdicts.
Used vs new: price_check with new_price (the lowest new price from a shop price comparison, e.g. Billigast) gives what share of the new price used ads ask.
"What's new since…": search with since (ISO time). For push alerts, give the user blocket_url to save as a search in the Blocket app.
Always link each ad's url. Keep at most 3 calls in parallel.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const VERTICAL_TEXT =
  "torget = general marketplace (furniture, electronics, clothes, kids, hobby, tools...); car, boat, mc (motorcycles), caravan (husvagn), motorhome (husbil), truck (lastbil/släp), tractor, combine (skördetröska), snowmobile, atv, moped (mopeder/scooters), bus.";
const vertical = z.enum(VERTICALS).describe(VERTICAL_TEXT);

const filterParams = {
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Search words, ideally Swedish ('soffa', 'barnvagn', 'V70', 'Hallberg-Rassy'). Blocket operators: -word excludes a word, a OR b matches either, \"exact phrase\", word* matches a prefix.",
    ),
  places: z
    .array(z.string().min(1))
    .optional()
    .describe("Counties (län) or municipalities, e.g. ['Stockholm'], ['Nacka', 'Värmdö'], ['Västra Götaland']. Omit for all of Sweden."),
  near: z
    .object({
      lat: z.number().min(55).max(70).describe("Latitude (WGS84)."),
      lon: z.number().min(10).max(25).describe("Longitude (WGS84)."),
      radius_km: z.number().positive().max(500).describe("Radius in km."),
    })
    .optional()
    .describe("Only ads within radius_km of a point; rows then carry distance_km."),
  price_min: z.number().int().min(0).optional().describe("Lowest price, SEK."),
  price_max: z.number().int().min(0).optional().describe("Highest price, SEK."),
  year_min: z.number().int().optional().describe("Earliest model year (vehicles)."),
  year_max: z.number().int().optional().describe("Latest model year (vehicles)."),
  mileage_min_mil: z.number().int().min(0).optional().describe("Lowest mileage in Swedish mil (1 mil = 10 km)."),
  mileage_max_mil: z.number().int().min(0).optional().describe("Highest mileage in Swedish mil (1 mil = 10 km)."),
  seller: z.enum(["private", "dealer"]).optional().describe("Only private sellers or only dealers (companies)."),
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
        z.string().describe("One value label."),
        z.array(z.string()).describe("Several value labels (any of them)."),
        z
          .object({ min: z.number().optional().describe("Lowest value."), max: z.number().optional().describe("Highest value.") })
          .describe("Range for numeric filters."),
      ]),
    )
    .optional()
    .describe(
      "Vertical-specific filters by Blocket filter name → value label(s) or {min,max}. Examples: car {make: 'Volvo', model: 'V70', fuel: 'Diesel', transmission: 'Automatisk', body_type: 'Kombi', car_equipment: ['Dragkrok']}; boat {class: 'Segelbåt', make: 'Najad', length_feet: {min: 28}}; torget {category: 'Möbler och inredning', condition: 'Mycket bra skick - som ny', brand: 'IKEA'}. Unsure? Call list_filters.",
    ),
};

const relevanceParams = {
  require: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe("Words or phrases that must all appear in the row's title or specs (case-insensitive), e.g. ['128gb']."),
  exclude: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe(
      "Drop rows whose title or specs contain any of these (case-insensitive, also inside words), e.g. ['skal', 'laddare', 'köpes'] for a phone. 'köpes' and 'bortskänkes' also drop wanted ads and giveaways.",
    ),
  title_only: z.boolean().optional().describe("Keep only rows whose title contains every word of query."),
};

function failure(error: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

function result(run: () => Promise<object>) {
  return run().then(
    (data) => ({
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      structuredContent: data as Record<string, unknown>,
    }),
    failure,
  );
}

export function registerTools(server: McpServer) {
  server.registerTool(
    "search",
    {
      title: "Search Blocket",
      description:
        "Search live Blocket ads in any vertical with filters, distance and sorting. Returns compact rows (price, place, age, seller, badges, key specs, url, photo, risk_words), the total count, the filters applied, unmatched filter values with suggestions, optional facets (value counts to refine with) and blocket_url (the same search on blocket.se). exclude/require/title_only drop off-topic rows and read up to 4 more pages to refill (scanned, dropped, next_page). deals labels each row's price against the same search's asking prices (deal_basis). Not for prices in shops (new products): use a price comparison tool such as Billigast.",
      inputSchema: {
        vertical: vertical.default("torget").describe(`Default torget. ${VERTICAL_TEXT}`),
        ...filterParams,
        ...relevanceParams,
        deals: z
          .boolean()
          .optional()
          .describe(
            "Label each row's price great/good/fair/high with its percentile and % vs the median asking price of up to 200 ads of the same search (deal_basis). Costs one extra request.",
          ),
        since: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("ISO time: only ads published after it (newest first). Use for 'anything new since…'."),
        sort: z
          .enum(SORTS)
          .optional()
          .describe(
            "Default relevance. closest needs near; year_*/mileage_* vehicles; length_* boats. deal = cheapest vs the median first (implies deals).",
          ),
        page: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Blocket result page, default 1. Pass next_page from a previous response to continue."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Ads per page, default 20. With exclude/require/title_only a response can hold a few more."),
        facets: z.boolean().optional().describe("Also return value counts for the main filters (market overview, refining)."),
      },
      annotations: { title: "Search Blocket", ...READ_ONLY },
      _meta: WIDGET_TOOL_META,
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
        filter: z.string().min(1).optional().describe("One filter name (e.g. 'make') to list all its values."),
        query: z.string().min(1).optional().describe("Substring to find filter values by (e.g. 'hallberg')."),
      },
      annotations: { title: "List Blocket filters", ...READ_ONLY },
    },
    ({ vertical, filter, query }) => result(() => listFilters(vertical, filter, query)),
  );

  server.registerTool(
    "get_ad",
    {
      title: "Get Blocket ads",
      description:
        "Full details of 1-5 ads by id or blocket.se URL: description, specs, equipment, all photos, place, status (active/sold/removed), seller (dealer, years on Blocket, other ads via seller.id), shipping/buy-now, favourites count, red flags and vehicle history links. Several ids render a comparison.",
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1).max(5).describe("Ad ids from search rows, or blocket.se ad URLs."),
      },
      annotations: { title: "Get Blocket ads", ...READ_ONLY },
      _meta: WIDGET_TOOL_META,
    },
    ({ ids }) => result(() => getAds(ids)),
  );

  server.registerTool(
    "get_ad_photos",
    {
      title: "Get Blocket ad photos",
      description:
        "An ad's photos as images (640 px wide JPEGs) to look at the item's condition yourself, plus its title, url and total photo count. Returns the first max photos (default 4, up to 8).",
      inputSchema: {
        id: z.string().min(1).describe("Ad id from a search row, or a blocket.se ad URL."),
        max: z.number().int().min(1).max(8).optional().describe("Number of photos, default 4, at most 8."),
      },
      annotations: { title: "Get Blocket ad photos", ...READ_ONLY },
    },
    ({ id, max }) =>
      getAdPhotos(id, max).then(({ photos, ...ad }) => {
        const data = { ...ad, photos: photos.map(({ data: _, ...photo }) => photo) };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data) },
            ...photos.map((photo) => ({ type: "image" as const, data: photo.data, mimeType: photo.mimeType })),
          ],
          structuredContent: data,
        };
      }, failure),
  );

  server.registerTool(
    "price_check",
    {
      title: "Check a Blocket price",
      description:
        "Use this when the user asks what a used item sells for on Blocket, whether an asking price is fair, or whether to buy used or new. Returns the asking-price distribution (p10/p25/median/p75/p90) of comparable live ads, with up to 6 example ads. Give ad_id to judge that ad (comparables are derived from its make, model, year, mileage or length; its percentile is returned), or describe the item with the search filters. For Torget items pass a short query (e.g. 'iphone 13 128gb') for good comparables; for mass-market products (phones, consoles, headphones) also pass title_only and excludes for accessories and wanted ads, e.g. ['skal', 'fodral', 'laddare', 'kontroll', 'controller', 'headset', 'fäste', 'cover', 'köpes', 'bytes']. With require/exclude/title_only the stats come from those of the newest 200 ads that pass them (scanned, dropped). Pass new_price when a shop price comparison gave you one: vs_new says what % of it the median and the ad ask, and ads under 10% of it are left out as accessories or parts. Explicit filters override the derived ones.",
      inputSchema: {
        ad_id: z.string().min(1).optional().describe("Ad id or blocket.se URL to judge."),
        vertical: vertical.optional().describe(`Default torget, or the ad's vertical with ad_id. ${VERTICAL_TEXT}`),
        ...filterParams,
        ...relevanceParams,
        new_price: z
          .number()
          .positive()
          .optional()
          .describe("Current lowest new price of the same model in Swedish shops (e.g. Billigast compare's cheapest.price), SEK incl. VAT."),
      },
      annotations: { title: "Check a Blocket price", ...READ_ONLY },
      _meta: WIDGET_TOOL_META,
    },
    (args) => result(() => priceCheck(args)),
  );
}
