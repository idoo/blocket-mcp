// Per-vertical knowledge of blocket.se: search endpoints, web search pages, supported sort orders, facets and row specs.
// Paths, slugs and sort values were checked live against blocket.se (2026-11-06).

import type { Sort, Vertical } from "../types";

/** The subset of a Blocket search doc this server reads (vehicles and Torget share one shape with optional fields). */
export type Doc = {
  id: string | number;
  heading?: string;
  location?: string;
  timestamp?: number;
  coordinates?: { lat: number; lon: number };
  distance?: number;
  price?: { amount?: number; amount_ex_vat?: number };
  image?: { url?: string; path?: string };
  flags?: string[];
  labels?: { id: string; text: string }[];
  canonical_url?: string;
  trade_type?: string;
  extras?: { id: string; values?: string[] }[];
  org_id?: string;
  organisation_name?: string;
  dealer_segment?: string;
  sales_form?: number;
  year?: number;
  mileage?: number;
  make?: string;
  model?: string;
  regno?: string;
  fuel?: string;
  transmission?: string;
  volume?: number;
  boat_class?: string;
  length?: number;
  motor_size?: number;
  motor_type?: string;
  motor_fuel?: string;
};

export type VerticalConfig = {
  /** Blocket search key without the SEARCH_ID_ prefix. */
  key: string;
  /** JSON search endpoint. */
  apiPath: string;
  /** The blocket.se web search page for the same search (takes the same query parameters). */
  webPath: string;
  /** Our sort → Blocket's sort value. Missing = unsupported for this vertical. */
  sorts: Partial<Record<Sort, string>>;
  /** Filters shown as facets, most useful first. */
  facets: string[];
  specs: (doc: Doc) => Record<string, string | number>;
};

const COMMON_SORTS = {
  relevance: "RELEVANCE",
  newest: "PUBLISHED_DESC",
  oldest: "PUBLISHED_ASC",
  price_asc: "PRICE_ASC",
  price_desc: "PRICE_DESC",
  closest: "CLOSEST",
} as const satisfies Partial<Record<Sort, string>>;
const YEAR_SORTS = { year_desc: "YEAR_DESC", year_asc: "YEAR_ASC" } as const;
const MILEAGE_SORTS = { mileage_asc: "MILEAGE_ASC", mileage_desc: "MILEAGE_DESC" } as const;
const LENGTH_SORTS = { length_desc: "LENGTH_DESC", length_asc: "LENGTH_ASC" } as const;

function compact(entries: Record<string, string | number | undefined | null>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(entries)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

const positive = (n: number | undefined) => (typeof n === "number" && n > 0 ? n : undefined);

function vehicleSpecs(d: Doc): Record<string, string | number> {
  return compact({
    year: positive(d.year),
    mileage_mil: typeof d.mileage === "number" ? d.mileage : undefined,
    make: d.make,
    model: d.model,
    fuel: d.fuel,
    gearbox: d.transmission,
    regno: d.regno?.toUpperCase(),
    engine: positive(d.volume) ? `${d.volume} cc` : undefined,
  });
}

function boatSpecs(d: Doc): Record<string, string | number> {
  return compact({
    year: positive(d.year),
    make: d.make,
    class: d.boat_class,
    length_ft: positive(d.length),
    hp: positive(d.motor_size),
    engine: [d.motor_type, d.motor_fuel].filter(Boolean).join(", ") || undefined,
  });
}

const TORGET_API = "/recommerce/forsale/search/api/search/SEARCH_ID_";
const VEHICLE_API = "/mobility/search/api/search/SEARCH_ID_";

function vehicle(key: string, web: string, sorts: Partial<Record<Sort, string>>, facets: string[]): VerticalConfig {
  return { key, apiPath: VEHICLE_API + key, webPath: "/mobility/search/" + web, sorts: { ...COMMON_SORTS, ...YEAR_SORTS, ...sorts }, facets, specs: vehicleSpecs };
}

export const VERTICAL_CONFIG: Record<Vertical, VerticalConfig> = {
  torget: {
    key: "BAP_COMMON",
    apiPath: TORGET_API + "BAP_COMMON",
    webPath: "/recommerce/forsale/search",
    sorts: COMMON_SORTS,
    facets: ["category", "condition", "location", "trade_type", "shipping_types"],
    specs: (d) => compact({ make: d.extras?.find((e) => e.id === "brand")?.values?.[0] }),
  },
  car: vehicle("CAR_USED", "car", MILEAGE_SORTS, ["variant", "fuel", "body_type", "transmission", "location"]),
  boat: { ...vehicle("BOAT_USED", "boat", LENGTH_SORTS, ["class", "make", "location", "fuel", "material"]), specs: boatSpecs },
  mc: vehicle("MC_USED", "mc", MILEAGE_SORTS, ["make", "type", "location", "engine_fuel"]),
  caravan: vehicle("CAR_CARAVAN", "caravan", {}, ["make", "location", "no_of_sleepers", "caravancondition"]),
  motorhome: vehicle("CAR_MOBILE_HOME", "caravan/mobilehome", MILEAGE_SORTS, ["make", "mobile_home_segment", "location", "no_of_sleepers"]),
  truck: vehicle("CAR_TRUCK", "b2b/truck", MILEAGE_SORTS, ["truck_segment", "make", "location"]),
  tractor: vehicle("AGRICULTURE_TRACTOR", "b2b/agriculturetractor", {}, ["make", "location", "dealer_segment"]),
  combine: vehicle("AGRICULTURE_THRESHING", "b2b/agriculturecombines", {}, ["make", "location", "dealer_segment"]),
  snowmobile: vehicle("MC_SNOWMOBILE", "mc/snowmobile", MILEAGE_SORTS, ["make", "location", "dealer_segment"]),
  atv: vehicle("MC_ATV", "mc/atv", MILEAGE_SORTS, ["make", "location", "dealer_segment"]),
  moped: vehicle("MC_SCOOTER", "mc/scooter", MILEAGE_SORTS, ["make", "type", "location", "engine_fuel"]),
  bus: vehicle("CAR_BUS", "b2b/bus", {}, ["make", "bus_segment", "location"]),
};
