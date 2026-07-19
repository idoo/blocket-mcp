// Search on blocket.se: typed params → Blocket query (with names resolved to ids), compact rows, facets and the matching web URL.

import type { AppliedFilter, Facet, Row, SearchResult, Sort, UnmatchedFilter, Vertical } from "../types";
import { BlocketError, getJson, SITE } from "./http";
import { type BlocketFilter, findFilter, flatten, getFilters, nodeLabel, parseFilters, resolveValue, suggest } from "./filters";
import { type Doc, VERTICAL_CONFIG } from "./verticals";

export type SearchParams = {
  vertical: Vertical;
  query?: string;
  places?: string[];
  near?: { lat: number; lon: number; radius_km: number };
  price_min?: number;
  price_max?: number;
  year_min?: number;
  year_max?: number;
  mileage_min_mil?: number;
  mileage_max_mil?: number;
  seller?: "private" | "dealer";
  trade?: "sale" | "giveaway" | "wanted";
  shipping?: boolean;
  new_today?: boolean;
  since?: string;
  seller_id?: string;
  filters?: Record<string, string | string[] | { min?: number; max?: number }>;
  sort?: Sort;
  page?: number;
  rows?: number;
  facets?: boolean;
};

export type BuiltQuery = {
  vertical: Vertical;
  path: string;
  params: URLSearchParams;
  applied: AppliedFilter[];
  unmatched: UnmatchedFilter[];
  blocket_url: string;
  near?: SearchParams["near"];
  /** Epoch ms: rows published before it are dropped and the sort is forced to newest. */
  since?: number;
};

const TRADE_TYPES = { sale: "1", giveaway: "2", wanted: "3" } as const;
const SELLER_LABELS = { private: "Privat", dealer: "Företag" } as const;

const fmt = (n: number) => n.toLocaleString("sv-SE").replace(/\u00a0/g, " ");

function rangeText(name: string, min: number | undefined, max: number | undefined, unit: string): string {
  // Years read wrong with thousands separators ("2 012").
  const f = name === "year" ? String : fmt;
  const u = unit ? ` ${unit}` : "";
  if (min !== undefined && max !== undefined) return `${f(min)}–${f(max)}${u}`;
  return min !== undefined ? `≥ ${f(min)}${u}` : `≤ ${f(max ?? 0)}${u}`;
}

function blocketUrl(webPath: string, params: URLSearchParams, sort?: string): string {
  const p = new URLSearchParams(params);
  if (sort) p.set("sort", sort);
  const qs = p.toString();
  return SITE + webPath + (qs ? `?${qs}` : "");
}

export async function buildQuery(p: SearchParams): Promise<BuiltQuery> {
  const cfg = VERTICAL_CONFIG[p.vertical];
  const params = new URLSearchParams();
  const applied: AppliedFilter[] = [];
  const unmatched: UnmatchedFilter[] = [];
  let meta: BlocketFilter[] | undefined;
  const filters = async () => (meta ??= await getFilters(p.vertical));

  const notAvailable = async (name: string, value: string) =>
    unmatched.push({ name, value, suggestions: suggest(name, (await filters()).map((f) => ({ label: f.name }))) });

  const applyValues = async (name: string, values: string[], shown = name) => {
    const f = findFilter(await filters(), name);
    if (!f || f.type !== "STANDARD_FILTER") return notAvailable(name, values.join(", "));
    for (const v of values) {
      const r = resolveValue(f, v);
      if ("value" in r) {
        params.append(f.name, r.value);
        applied.push({ name: shown, value: r.label });
      } else unmatched.push({ name, value: v, suggestions: r.suggestions });
    }
  };

  const applyRange = async (name: string, min: number | undefined, max: number | undefined) => {
    if (min === undefined && max === undefined) return;
    const f = findFilter(await filters(), name);
    if (!f || f.type !== "RANGE_FILTER") return notAvailable(name, rangeText(name, min, max, ""));
    if (min !== undefined) params.set(f.name_from ?? `${f.name}_from`, String(min));
    if (max !== undefined) params.set(f.name_to ?? `${f.name}_to`, String(max));
    applied.push({ name, value: rangeText(name, min, max, f.unit ?? "") });
  };

  if (p.query?.trim()) {
    params.set("q", p.query.trim());
    applied.push({ name: "query", value: p.query.trim() });
  }
  if (p.places?.length) await applyValues("location", p.places);
  if (p.near) {
    params.set("lat", String(p.near.lat));
    params.set("lon", String(p.near.lon));
    params.set("radius", String(Math.round(p.near.radius_km * 1000)));
    applied.push({ name: "near", value: `${fmt(p.near.radius_km)} km from ${p.near.lat}, ${p.near.lon}` });
  }
  await applyRange("price", p.price_min, p.price_max);
  await applyRange("year", p.year_min, p.year_max);
  await applyRange("mileage", p.mileage_min_mil, p.mileage_max_mil);
  if (p.seller) await applyValues("dealer_segment", [SELLER_LABELS[p.seller]], "seller");
  if (p.trade) {
    if ((await filters()).some((f) => f.name === "trade_type")) {
      params.set("trade_type", TRADE_TYPES[p.trade]);
      applied.push({ name: "trade", value: p.trade });
    } else await notAvailable("trade", p.trade);
  }
  if (p.shipping) {
    if ((await filters()).some((f) => f.name === "shipping_types")) {
      params.set("shipping_types", "0");
      applied.push({ name: "shipping", value: "Kan skickas" });
    } else await notAvailable("shipping", "true");
  }
  if (p.new_today) {
    params.set("published", "1");
    applied.push({ name: "new_today", value: "Nytt från idag" });
  }
  if (p.seller_id) {
    params.set("orgId", p.seller_id);
    applied.push({ name: "seller_id", value: p.seller_id });
  }
  let since: number | undefined;
  if (p.since) {
    since = Date.parse(p.since);
    if (Number.isNaN(since)) throw new BlocketError(`since must be an ISO date-time, got "${p.since}"`);
    applied.push({ name: "since", value: new Date(since).toISOString() });
  }

  const rest = { ...p.filters };
  // {make, model} on cars is one value of the make→model `variant` tree.
  if (typeof rest.make === "string" && typeof rest.model === "string" && findFilter(await filters(), "make")?.name === "variant") {
    rest.make = `${rest.make} ${rest.model}`;
    delete rest.model;
  }
  for (const [name, value] of Object.entries(rest)) {
    if (typeof value === "string") await applyValues(name, [value]);
    else if (Array.isArray(value)) await applyValues(name, value);
    else await applyRange(name, value.min, value.max);
  }

  return {
    vertical: p.vertical,
    path: cfg.apiPath,
    params,
    applied,
    unmatched,
    blocket_url: blocketUrl(cfg.webPath, params),
    ...(p.near ? { near: p.near } : {}),
    ...(since !== undefined ? { since } : {}),
  };
}

function blocketSort(vertical: Vertical, sort: Sort, near: boolean): string {
  const value = VERTICAL_CONFIG[vertical].sorts[sort];
  if (!value) {
    const ok = Object.keys(VERTICAL_CONFIG[vertical].sorts).join(", ");
    throw new BlocketError(`Sort "${sort}" is not available for ${vertical}; use one of: ${ok}`);
  }
  if (sort === "closest" && !near) throw new BlocketError('Sort "closest" needs `near` (lat, lon, radius_km)');
  return value;
}

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function age(ms: number, now: number): string {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  const days = Math.round(min / 1440);
  return days < 60 ? `${days} d` : `${Math.round(days / 30)} mån`;
}

const stockholmDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" });

function toRow(vertical: Vertical, d: Doc, near: SearchParams["near"], now: number): Row {
  const flags = new Set([...(d.flags ?? []), ...(d.labels ?? []).map((l) => l.id)]);
  const badges: string[] = [];
  const ts = d.timestamp ?? 0;
  if (ts && stockholmDay.format(ts) === stockholmDay.format(now)) badges.push("new_today");
  if (d.trade_type === "Bortskänkes") badges.push("giveaway");
  if (d.trade_type === "Köpes") badges.push("wanted");
  if (flags.has("shipping_exists") || flags.has("fiks_ferdig")) badges.push("shipping");
  if (flags.has("seller_pays_shipping")) badges.push("free_shipping");
  if (flags.has("buy_now")) badges.push("buy_now");
  if (flags.has("smooth_trade") || flags.has("smidig_bilhandel")) badges.push("tryggad");
  if (d.price?.amount_ex_vat) badges.push("vat_deductible");
  if (flags.has("sold") || flags.has("disposed")) badges.push("sold");
  if (d.sales_form === 5) badges.push("leasing");
  if (d.sales_form === 2) badges.push("new_vehicle");

  const isPrivate = d.dealer_segment ? d.dealer_segment === "Privat" : flags.has("private");
  const row: Row = {
    id: String(d.id),
    vertical,
    title: d.heading ?? "",
    price: d.price?.amount ? d.price.amount : null,
    place: d.location ?? "",
    published: new Date(ts).toISOString(),
    age: age(ts, now),
    seller: {
      type: isPrivate ? "private" : "dealer",
      ...(!isPrivate && d.organisation_name ? { name: d.organisation_name } : {}),
      ...(d.org_id ? { id: d.org_id } : {}),
    },
    badges,
    specs: VERTICAL_CONFIG[vertical].specs(d),
    url: d.canonical_url ?? `${SITE}/${vertical === "torget" ? "recommerce/forsale" : "mobility"}/item/${d.id}`,
  };
  if (near) {
    const km = d.distance && d.distance > 0 ? d.distance : d.coordinates ? haversineKm(near, d.coordinates) : undefined;
    if (km !== undefined) row.distance_km = Math.round(km * 10) / 10;
  }
  if (d.image?.path) row.image = `https://images.blocketcdn.se/dynamic/480w/${d.image.path}`;
  else if (d.image?.url) row.image = d.image.url;
  return row;
}

type SearchJson = {
  docs?: Doc[];
  metadata?: { sort?: string; paging?: { last?: number }; result_size?: { match_count?: number } };
};

export async function fetchRows(
  q: BuiltQuery,
  opts: { rows: number; page: number; sort?: Sort },
): Promise<{ total: number; last_page: number; rows: Row[] }> {
  const sort = q.since !== undefined ? "newest" : opts.sort;
  const params = new URLSearchParams(q.params);
  params.set("rows", String(opts.rows));
  params.set("page", String(opts.page));
  params.set("include_filters", "false");
  const wanted = sort && sort !== "relevance" ? blocketSort(q.vertical, sort, !!q.near) : undefined;
  if (wanted) params.set("sort", wanted);
  const json = (await getJson(`${q.path}?${params}`)) as SearchJson;
  // Blocket silently falls back to its default order for sorts a vertical lacks.
  if (wanted && json.metadata?.sort && json.metadata.sort !== wanted) {
    throw new BlocketError(`Blocket does not sort ${q.vertical} by ${sort}`);
  }
  const now = Date.now();
  let docs = json.docs ?? [];
  if (q.since !== undefined) docs = docs.filter((d) => (d.timestamp ?? 0) >= (q.since ?? 0));
  return {
    total: json.metadata?.result_size?.match_count ?? 0,
    last_page: json.metadata?.paging?.last ?? 1,
    rows: docs.map((d) => toRow(q.vertical, d, q.near, now)),
  };
}

async function fetchFacets(q: BuiltQuery): Promise<Facet[]> {
  const params = new URLSearchParams(q.params);
  params.set("rows", "1");
  params.set("include_filters", "true");
  const filters = parseFilters(await getJson(`${q.path}?${params}`));
  const facets: Facet[] = [];
  for (const name of VERTICAL_CONFIG[q.vertical].facets) {
    const f = filters.find((x) => x.name === name);
    if (!f || f.type !== "STANDARD_FILTER") continue;
    // Facet counts ignore the facet's own selection; a selected make or county is more useful broken down into its children.
    const selected = new Set(q.params.getAll(f.name));
    const parents = (f.filter_items ?? []).filter((item) => flatten([item]).some((x) => selected.has(x.value)));
    const parent = parents.length === 1 && parents[0].filter_items?.length ? parents[0] : undefined;
    const depth = parent ? 1 : 0;
    const values = (parent ? flatten(parent.filter_items, 1, parent.display_name) : flatten(f.filter_items))
      .filter((x) => x.depth === depth && x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 6)
      .map((x) => ({ label: nodeLabel(f, x), count: x.hits }));
    if (values.length > 1) facets.push({ name: f.name, label: f.display_name, values });
    if (facets.length === 5) break;
  }
  return facets;
}

export async function search(p: SearchParams): Promise<SearchResult> {
  const q = await buildQuery(p);
  const page = Math.min(Math.max(p.page ?? 1, 1), 50);
  const rows = Math.min(Math.max(p.rows ?? 20, 1), 50);
  const sort = q.since !== undefined ? "newest" : p.sort;
  const [result, facets] = await Promise.all([fetchRows(q, { rows, page, sort }), p.facets ? fetchFacets(q) : undefined]);
  const webSort = sort && sort !== "relevance" ? VERTICAL_CONFIG[p.vertical].sorts[sort] : undefined;
  return {
    vertical: p.vertical,
    total: result.total,
    page,
    last_page: result.last_page,
    rows: result.rows,
    applied: q.applied,
    unmatched: q.unmatched,
    ...(facets ? { facets } : {}),
    blocket_url: blocketUrl(VERTICAL_CONFIG[p.vertical].webPath, q.params, webSort),
  };
}
