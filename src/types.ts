// Shared contract between the Blocket client (src/blocket/*), the MCP tools (src/tools.ts) and the ChatGPT widget (src/widget/*).
// Every tool returns one of these objects as structuredContent and as JSON text; the widget renders the same objects.

export const VERTICALS = [
  "torget",
  "car",
  "boat",
  "mc",
  "caravan",
  "motorhome",
  "truck",
  "tractor",
  "combine",
  "snowmobile",
  "atv",
  "moped",
  "bus",
] as const;
export type Vertical = (typeof VERTICALS)[number];

/**
 * Result sort orders; not every vertical supports every order (src/blocket/verticals.ts maps them).
 * "deal" is computed by this server: Blocket's default order, then rows re-sorted by vs_median_pct.
 */
export const SORTS = [
  "relevance",
  "newest",
  "oldest",
  "price_asc",
  "price_desc",
  "closest",
  "year_desc",
  "year_asc",
  "mileage_asc",
  "mileage_desc",
  "length_desc",
  "length_asc",
  "deal",
] as const;
export type Sort = (typeof SORTS)[number];

export type Seller = {
  type: "private" | "dealer";
  /** Dealer name; private sellers have none in search rows. */
  name?: string;
  /** Blocket owner/org id: search({ seller_id }) lists this seller's other ads. */
  id?: string;
};

/**
 * Stable badge ids (the widget maps them to Swedish labels):
 * new_today, giveaway, wanted, shipping, free_shipping, buy_now, tryggad (Tryggad Bilaffär), vat_deductible, sold, leasing, new_vehicle.
 */
export type Badge = string;

/** Where a row's asking price sits among comparable ads of the same search (search with deals or sort "deal"). */
export type Deal = {
  /** Share of comparables priced below this row, 0-100. */
  percentile: number;
  /** Price vs the comparables' median in percent; negative = cheaper. */
  vs_median_pct: number;
  /** great ≤ p10, good ≤ p25, fair ≤ p75, high above. */
  label: "great" | "good" | "fair" | "high";
};

/** The comparables behind Row.deal: one Blocket request of up to 200 ads of the same search with usable asking prices. */
export type DealBasis =
  | { comparables: number; median: number; p25: number; p75: number }
  | { comparables: number; median: null; note: string };

/** One search hit, kept to a few hundred bytes. */
export type Row = {
  id: string;
  vertical: Vertical;
  title: string;
  /** SEK; null when the ad has no price. */
  price: number | null;
  /** Town or municipality as Blocket shows it. */
  place: string;
  /** Only when the search used `near`. Blocket coordinates are approximate. */
  distance_km?: number;
  /** ISO 8601 publish (or bump) time. */
  published: string;
  /** Human age at response time: "12 min", "5 h", "3 d", "2 mån". */
  age: string;
  seller: Seller;
  badges: Badge[];
  /**
   * Short per-vertical facts. Keys used: year, mileage_mil, fuel, gearbox, regno, make, model, length_ft, class, engine, hp,
   * condition (torget). Values are numbers or short strings; absent keys are omitted.
   */
  specs: Record<string, string | number>;
  url: string;
  /** Thumbnail (images.blocketcdn.se). */
  image?: string;
  /** Only when the search asked for deals and the row has a usable asking price. */
  deal?: Deal;
  /** Risk words found in the title (defekt, reservdelar, startar inte...); only when there are some. */
  risk_words?: string[];
};

/** A filter the server actually sent to Blocket, in human terms: { name: "make", value: "Volvo" }, { name: "price", value: "≤ 5 000 kr" }. */
export type AppliedFilter = { name: string; value: string };

/** A filter value the server could not map to a Blocket id; it was NOT applied. */
export type UnmatchedFilter = { name: string; value: string; suggestions: string[] };

export type Facet = { name: string; label: string; values: { label: string; count: number }[] };

export type SearchResult = {
  vertical: Vertical;
  /** Total matching ads on Blocket. */
  total: number;
  page: number;
  last_page: number;
  rows: Row[];
  applied: AppliedFilter[];
  unmatched: UnmatchedFilter[];
  /** Only when the call asked for facets. */
  facets?: Facet[];
  /** The same search on blocket.se (save it in the Blocket app for push alerts). */
  blocket_url: string;
  /** Ads looked at on Blocket for this response (more than rows.length when require/exclude/title_only dropped some). */
  scanned: number;
  /** Ads dropped by require/exclude/title_only. */
  dropped: number;
  /** Blocket page to continue from (pass as page with the same arguments), or null when there are no more. */
  next_page: number | null;
  /** Only with deals or sort "deal". */
  deal_basis?: DealBasis;
};

export type FilterInfo = {
  /** Key to use in search `filters` (Blocket's own filter name, e.g. "make", "body_type", "length_feet"). */
  name: string;
  /** Swedish label as Blocket shows it. */
  label: string;
  kind: "values" | "range";
  /** For kind "values": top values (or those matching the query) with live hit counts. */
  values?: { label: string; count: number }[];
  /** Number of values in total, when `values` is truncated. */
  total_values?: number;
  /** For kind "range". */
  range?: { min: number; max: number; unit?: string };
};

export type FiltersResult = { vertical: Vertical; filters: FilterInfo[] };

export type RedFlag = { level: "info" | "warn"; text: string };

export type AdDetail = {
  id: string;
  vertical: Vertical;
  title: string;
  /** SEK; null when the ad has no price. */
  price: number | null;
  status: "active" | "sold" | "removed";
  description?: string;
  /** Label → value as Blocket shows it (Swedish labels), e.g. { "Miltal": "4 405 mil", "Växellåda": "Manuell" }. */
  specs: Record<string, string>;
  equipment?: string[];
  /** Full-size image URLs, in Blocket's order. */
  images: string[];
  place: { city?: string; postal_code?: string; lat?: number; lon?: number };
  published?: string;
  edited?: string;
  seller: Seller & {
    /** e.g. "5+ år på Blocket". */
    member_since?: string;
    /** Number of active ads by this seller, when Blocket shows it. */
    ad_count?: number;
    address?: string;
    /**
     * Dealer rating shown on vehicle ads. Blocket links it to Google Maps reviews (scale 5);
     * Blocket's own seller reviews are not in the ad page.
     */
    rating?: { score: number; count: number; scale: number; source: "google" };
  };
  /** Torget only: Blocket shipping and buy-now (Blocket's protected payment). */
  shipping?: { can_ship: boolean; buy_now: boolean; seller_pays: boolean };
  /** Vehicle ads: numbers parsed from the specs and price box, only those Blocket shows. */
  vehicle?: {
    /** "Effekt" (cars, MC) or "Motorstorlek" (boats), in hk. */
    horsepower?: number;
    /** "Räckvidd (WLTP)", electric vehicles. */
    range_km?: number;
    /** "Batterikapacitet", electric vehicles. */
    battery_kwh?: number;
    /** True when the dealer shows a price excluding VAT (VAT can be deducted by companies). */
    vat_deductible?: boolean;
    /** SEK excluding VAT, as the dealer shows it. */
    price_excl_vat?: number;
  };
  /** How many users saved the ad as a favourite (demand signal). */
  favorites?: number;
  /** Facts worth checking before paying or driving; never a verdict. */
  red_flags: RedFlag[];
  /** Vehicles with a registration number: history lookups (car.info, biluppgifter.se). */
  history_links?: { label: string; url: string }[];
  url: string;
};

export type AdsResult = { ads: AdDetail[]; errors: { id: string; error: string }[] };

export type PriceCheck = {
  vertical: Vertical;
  /** Number of comparable live ads with a price. */
  comparables: number;
  /** Asking prices of live ads, never sold prices. */
  asking_price: { p10: number; p25: number; median: number; p75: number; p90: number } | null;
  /** When checking a specific ad: its price and percentile among the comparables (0-100). */
  ad?: { id: string; title: string; price: number | null; percentile: number | null };
  /** How the comparables were selected. */
  applied: AppliedFilter[];
  unmatched: UnmatchedFilter[];
  /** Up to 6 comparables around the median (or around the checked ad's price). */
  examples: Row[];
  blocket_url: string;
  /** With require/exclude/title_only: ads read (newest first, at most 200) and how many of them were dropped. */
  scanned?: number;
  dropped?: number;
  /** With new_price: integer % of the new price for the median asking price and the checked ad's price. */
  vs_new?: { new_price: number; median_pct: number | null; ad_pct: number | null };
  note: string;
};
