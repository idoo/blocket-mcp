// Search on blocket.se: typed params → Blocket query (with names resolved to ids), compact rows, facets and the matching web URL.
// Optional extras computed here: relevance filtering (require/exclude/title_only) with capped auto-paging, deal annotations
// against the asking prices of the same search, and risk words in titles.

import type { AppliedFilter, Deal, DealBasis, Facet, Row, SearchResult, Sort, UnmatchedFilter, Vertical } from "../types";
import { BlocketError, getJson, SITE } from "./http";
import { type BlocketFilter, findFilter, flatten, getFilters, nodeLabel, parseFilters, resolveValue, suggest } from "./filters";
import { askingPriceParams, isAskingPrice, quantile } from "./price";
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
  /** Words/phrases that must all appear in the row's title or specs. */
  require?: string[];
  /** Rows whose title, specs or trade type contain any of these are dropped. */
  exclude?: string[];
  /** Every word of `query` must appear in the title. */
  title_only?: boolean;
  /** Annotate rows with where their price sits among the same search's asking prices. */
  deals?: boolean;
};

/** Title words that point at a broken, incomplete or unregistered item. Matched as whole words, case-insensitive. */
export const RISK_WORDS = [
  "defekt",
  "defekta",
  "trasig",
  "trasigt",
  "trasiga",
  "fungerar inte",
  "fungerar ej",
  "reservdel",
  "reservdelar",
  "reservdelsbil",
  "reservdelsobjekt",
  "renoveringsobjekt",
  "renoveringsprojekt",
  "startar inte",
  "startar ej",
  "går inte igång",
  "går ej igång",
  "motorhaveri",
  "motorras",
  "säljes i delar",
  "säljes som delar",
  "i befintligt skick",
  "befintligt skick",
  "ej besiktigad",
  "ej besiktad",
  "obesiktigad",
  "avställd",
  "avställt",
  "skadad",
  "skadat",
  "skadade",
  "vattenskadad",
  "vattenskadat",
  "vattenskada",
  "krockskadad",
  "fuktskadad",
] as const;

const norm = (s: string) => s.normalize("NFC").toLocaleLowerCase("sv-SE");

// Longest first so "i befintligt skick" wins over "befintligt skick"; letters/digits may not touch either end.
const RISK_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(${[...RISK_WORDS]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/ /g, "\\s+"))
    .join("|")})(?![\\p{L}\\p{N}])`,
  "gu",
);

/** Risk words in a title, normalized to their RISK_WORDS spelling. */
export function riskWords(title: string): string[] {
  return [...new Set([...norm(title).matchAll(RISK_PATTERN)].map((m) => m[1]!.replace(/\s+/g, " ")))];
}

/** How Blocket shows trade types, so exclude: ["köpes"] drops wanted ads even when the title doesn't say it. */
const TRADE_TEXT: Record<string, string> = { giveaway: "bortskänkes", wanted: "köpes" };

/**
 * The words of a Blocket query that title_only checks, as groups of alternatives: `a OR b` is one group, "exact phrase"
 * one word, `word*` a prefix (substring matching covers it). Excluded words (`-word`) are Blocket's job and skipped.
 */
function queryGroups(query: string): string[][] {
  const groups: string[][] = [];
  let or = false;
  for (const m of query.matchAll(/(-)?(?:"([^"]*)"|(\S+))/g)) {
    if (!m[1] && m[3] === "OR") {
      or = groups.length > 0;
      continue;
    }
    const word = norm((m[2] ?? m[3] ?? "").replace(/["*]/g, "").trim());
    if (!m[1] && word) {
      if (or) groups.at(-1)!.push(word);
      else groups.push([word]);
    }
    or = false;
  }
  return groups;
}

/** The require/exclude/title_only test for a row, or undefined when none is set. Case-insensitive substring matching. */
function relevanceFilter(p: SearchParams): ((row: Row) => boolean) | undefined {
  const required = (p.require ?? []).map((w) => norm(w.trim())).filter(Boolean);
  const excluded = (p.exclude ?? []).map((w) => norm(w.trim())).filter(Boolean);
  const groups = p.title_only && p.query ? queryGroups(p.query) : [];
  if (!required.length && !excluded.length && !groups.length) return undefined;
  return (row) => {
    const title = norm(row.title);
    const text = [title, ...Object.values(row.specs).map((v) => norm(String(v))), ...row.badges.map((b) => TRADE_TEXT[b] ?? "")].join("\n");
    return (
      required.every((w) => text.includes(w)) &&
      !excluded.some((w) => text.includes(w)) &&
      groups.every((alternatives) => alternatives.some((w) => title.includes(w)))
    );
  };
}

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
  const risks = riskWords(row.title);
  if (risks.length) row.risk_words = risks;
  return row;
}

type SearchJson = {
  docs?: Doc[];
  metadata?: { sort?: string; paging?: { last?: number }; result_size?: { match_count?: number } };
};

export async function fetchRows(
  q: BuiltQuery,
  opts: { rows: number; page: number; sort?: Sort },
): Promise<{ total: number; last_page: number; rows: Row[]; scanned: number }> {
  const sort = q.since !== undefined ? "newest" : opts.sort;
  const params = new URLSearchParams(q.params);
  params.set("rows", String(opts.rows));
  params.set("page", String(opts.page));
  params.set("include_filters", "false");
  // "deal" is Blocket's default order re-sorted locally.
  const wanted = sort && sort !== "relevance" && sort !== "deal" ? blocketSort(q.vertical, sort, !!q.near) : undefined;
  if (wanted) params.set("sort", wanted);
  const json = (await getJson(`${q.path}?${params}`)) as SearchJson;
  // Blocket silently falls back to its default order for sorts a vertical lacks.
  if (wanted && json.metadata?.sort && json.metadata.sort !== wanted) {
    throw new BlocketError(`Blocket does not sort ${q.vertical} by ${sort}`);
  }
  const now = Date.now();
  const all = json.docs ?? [];
  const docs = q.since !== undefined ? all.filter((d) => (d.timestamp ?? 0) >= (q.since ?? 0)) : all;
  return {
    total: json.metadata?.result_size?.match_count ?? 0,
    last_page: json.metadata?.paging?.last ?? 1,
    rows: docs.map((d) => toRow(q.vertical, d, q.near, now)),
    scanned: all.length,
  };
}

/** Extra Blocket pages one search may read to refill rows dropped by require/exclude/title_only, and ads it may look at. */
const MAX_EXTRA_PAGES = 4;
const MAX_SCANNED = 200;

type Scan = { total: number; last_page: number; rows: Row[]; scanned: number; dropped: number; next_page: number | null };

/**
 * Reads `page` and, while `keep` drops rows and fewer than `rows` matches are found, the following pages (capped).
 * Matches of every page read are returned, so a filtered response can hold a few more than `rows` and no match is skipped.
 */
async function scanRows(q: BuiltQuery, opts: { rows: number; page: number; sort?: Sort }, keep?: (row: Row) => boolean): Promise<Scan> {
  const out: Row[] = [];
  let page = opts.page;
  let scanned = 0;
  let dropped = 0;
  for (let extra = 0; ; extra++) {
    const res = await fetchRows(q, { ...opts, page });
    scanned += res.scanned;
    for (const row of res.rows) {
      if (!keep || keep(row)) out.push(row);
      else dropped++;
    }
    // Under `since` (newest first) a page that lost rows to it has reached older ads: nothing new follows.
    const more = page < Math.min(res.last_page, 50) && res.rows.length === res.scanned && res.scanned > 0;
    const base = { total: res.total, last_page: res.last_page, rows: out, scanned, dropped };
    if (!more) return { ...base, next_page: null };
    if (!keep || out.length >= opts.rows || extra === MAX_EXTRA_PAGES || scanned + opts.rows > MAX_SCANNED) {
      return { ...base, next_page: page + 1 };
    }
    page++;
  }
}

type DealStats = { sorted: number[]; p10: number; p25: number; median: number; p75: number };

/** With fewer usable asking prices than this, rows get no deal annotation. */
const MIN_COMPARABLES = 8;

/**
 * Asking prices of the same search (every filter, no paging, no `since`) from one request of up to 200 ads, after the
 * relevance filter and without giveaways, wanted ads, leasing and placeholders.
 */
async function dealStats(p: SearchParams, keep?: (row: Row) => boolean): Promise<{ basis: DealBasis; stats?: DealStats }> {
  const { since: _since, page: _page, rows: _rows, sort: _sort, ...rest } = p;
  const q = await buildQuery(askingPriceParams(rest));
  const { rows } = await fetchRows(q, { rows: 200, page: 1 });
  const sorted = rows
    .filter((r) => (!keep || keep(r)) && isAskingPrice(r))
    .map((r) => r.price as number)
    .sort((a, b) => a - b);
  if (sorted.length < MIN_COMPARABLES) {
    return { basis: { comparables: sorted.length, median: null, note: "too few comparable ads" } };
  }
  const stats = { sorted, p10: quantile(sorted, 0.1), p25: quantile(sorted, 0.25), median: quantile(sorted, 0.5), p75: quantile(sorted, 0.75) };
  return { basis: { comparables: sorted.length, median: stats.median, p25: stats.p25, p75: stats.p75 }, stats };
}

function dealFor(price: number, s: DealStats): Deal {
  const below = s.sorted.filter((x) => x < price).length;
  return {
    percentile: Math.round((100 * below) / s.sorted.length),
    vs_median_pct: Math.round((100 * (price - s.median)) / s.median),
    label: price <= s.p10 ? "great" : price <= s.p25 ? "good" : price <= s.p75 ? "fair" : "high",
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
  const keep = relevanceFilter(p);
  const deals = p.deals || p.sort === "deal";
  const [scan, facets, deal] = await Promise.all([
    scanRows(q, { rows, page, sort }, keep),
    p.facets ? fetchFacets(q) : undefined,
    deals ? dealStats(p, keep) : undefined,
  ]);
  if (deal?.stats) {
    for (const row of scan.rows) if (isAskingPrice(row)) row.deal = dealFor(row.price, deal.stats);
  }
  if (p.sort === "deal") {
    scan.rows.sort((a, b) => (a.deal?.vs_median_pct ?? Infinity) - (b.deal?.vs_median_pct ?? Infinity));
  }
  const webSort = sort && sort !== "relevance" ? VERTICAL_CONFIG[p.vertical].sorts[sort] : undefined;
  return {
    vertical: p.vertical,
    total: scan.total,
    page,
    last_page: scan.last_page,
    rows: scan.rows,
    applied: q.applied,
    unmatched: q.unmatched,
    ...(facets ? { facets } : {}),
    blocket_url: blocketUrl(VERTICAL_CONFIG[p.vertical].webPath, q.params, webSort),
    scanned: scan.scanned,
    dropped: scan.dropped,
    next_page: scan.next_page,
    ...(deal ? { deal_basis: deal.basis } : {}),
  };
}
