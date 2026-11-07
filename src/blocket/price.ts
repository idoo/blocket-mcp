// Asking-price statistics for comparable live ads. Stateless: each percentile is one exact rank lookup under a price sort
// (Blocket caps paging at page 50, so a rank r is read with rows = ceil(r/50); the upper half is read from the top).

import type { AdDetail, PriceCheck, Row } from "../types.js";
import { getAd } from "./ad.js";
import { findFilter, getFilters } from "./filters.js";
import { BlocketError } from "./http.js";
import { buildQuery, fetchRows, type BuiltQuery, type SearchParams } from "./search.js";

export type PriceCheckParams = Partial<SearchParams> & { ad_id?: string };

/** Largest rank reachable in one direction: 50 pages × 200 rows. */
const MAX_RANK = 10_000;
const QUANTILES = [
  ["p10", 0.1],
  ["p25", 0.25],
  ["median", 0.5],
  ["p75", 0.75],
  ["p90", 0.9],
] as const;
const EXAMPLES = 6;
/** With fewer comparables than this, filters derived from an ad are relaxed one step at a time. */
const ENOUGH = 8;
/** 0 and 1 kr are placeholders ("ring för pris", "bud"), not asking prices. */
const MIN_PRICE = 2;

const NOTE =
  "Asking prices of live Blocket ads, not sold prices. Giveaways, wanted ads, leasing and 0-1 kr placeholders are excluded.";

export async function priceCheck(p: PriceCheckParams): Promise<PriceCheck> {
  const ad = p.ad_id ? await getAd(p.ad_id) : undefined;
  const { ad_id: _, ...rest } = p;
  const overrides = stripUndefined(rest);
  const derived = ad ? await comparablesFor(ad) : { params: { vertical: "torget" } as SearchParams, relax: [] };

  const relaxed: string[] = [];
  let params = askingPriceParams({ ...derived.params, ...overrides });
  let query = await buildQuery(params);
  // A derived value Blocket doesn't know (e.g. a model spelled differently) is reported in the note and dropped,
  // the model before the make, instead of being left as an ignored filter.
  for (let guard = 0; guard < 4 && ad; guard++) {
    const own = derived.params.filters ?? {};
    const miss = query.unmatched.find((u) => u.name in own && !overrides.filters?.[u.name]);
    if (!miss) break;
    const drop = miss.name === "make" && own.model ? "model" : miss.name;
    derived.params = { ...derived.params, filters: Object.fromEntries(Object.entries(own).filter(([name]) => name !== drop)) };
    relaxed.push(`no ${drop} filter (Blocket has no "${String(own[drop])}")`);
    params = askingPriceParams({ ...derived.params, ...overrides });
    query = await buildQuery(params);
  }
  let { total } = await fetchRows(query, { rows: 1, page: 1, sort: "price_asc" });
  for (const step of derived.relax) {
    if (total >= ENOUGH) break;
    const next = step.apply(derived.params);
    if (JSON.stringify(next) === JSON.stringify(derived.params)) continue;
    derived.params = next;
    relaxed.push(step.label);
    params = askingPriceParams({ ...derived.params, ...overrides });
    query = await buildQuery(params);
    ({ total } = await fetchRows(query, { rows: 1, page: 1, sort: "price_asc" }));
  }
  const note = relaxed.length ? `${NOTE} Comparison widened: ${relaxed.join("; ")}.` : NOTE;

  const base = {
    vertical: query.vertical,
    comparables: total,
    applied: query.applied,
    unmatched: query.unmatched,
    blocket_url: query.blocket_url,
  };
  const adSummary = ad ? { id: ad.id, title: ad.title, price: ad.price, percentile: null as number | null } : undefined;

  if (total === 0 || total > 2 * MAX_RANK) {
    const why = total === 0 ? "No comparable ads found; loosen the filters." : `Too broad (${total} ads); narrow the filters.`;
    return { ...base, asking_price: null, ad: adSummary, examples: [], note: `${why} ${note}` };
  }

  const lookups = QUANTILES.map(([, q]) => readRank(query, total, Math.min(total, Math.max(1, Math.ceil(q * total)))));
  const adRank = ad?.price != null && ad.price >= MIN_PRICE ? countBelow(params, ad.price).then((below) => below + 1) : undefined;
  const [prices, rankOfAd] = await Promise.all([Promise.all(lookups), adRank]);
  const [p10, p25, median, p75, p90] = prices.map((window) => window.target.price ?? 0) as [number, number, number, number, number];

  if (adSummary && rankOfAd !== undefined) adSummary.percentile = Math.round((100 * (rankOfAd - 1)) / total);
  const around = rankOfAd !== undefined ? await readRank(query, total, Math.min(total, rankOfAd)) : prices[2]!;
  const examples = nearest(around, ad?.id);

  return { ...base, asking_price: { p10, p25, median, p75, p90 }, ad: adSummary, examples, note };
}

/** Price-check invariants: only real asking prices of items for sale (no giveaways, wanted ads, leasing or 0-1 kr). */
export function askingPriceParams(params: SearchParams): SearchParams {
  const out: SearchParams = { ...params, price_min: Math.max(params.price_min ?? 0, MIN_PRICE) };
  if (out.vertical === "torget") out.trade = "sale";
  if (out.vertical === "car" && !out.filters?.sales_form) out.filters = { ...out.filters, sales_form: "Begagnad bil till salu" };
  return out;
}

/** Whether a row's price is a real asking price: not a giveaway, wanted ad, monthly leasing price or 0-1 kr placeholder. */
export function isAskingPrice(row: Row): row is Row & { price: number } {
  return (
    row.price != null &&
    row.price >= MIN_PRICE &&
    !row.badges.some((b) => b === "giveaway" || b === "wanted" || b === "leasing")
  );
}

/** Nearest-rank quantile (the same rank rule priceCheck uses) of ascending `sorted`, q in 0..1. */
export function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1]!;
}

type RankWindow = { rows: Row[]; index: number; target: Row };

/** Reads the ad at 1-based `rank` under ascending price, from whichever end is closer, with the smallest page that reaches it. */
async function readRank(query: BuiltQuery, total: number, rank: number): Promise<RankWindow> {
  const fromTop = total - rank + 1;
  const descending = fromTop < rank;
  const r = descending ? fromTop : rank;
  if (r > MAX_RANK) throw new BlocketError(`Rank ${rank} of ${total} is beyond Blocket's paging limit.`);
  const rows = Math.max(EXAMPLES, Math.ceil(r / 50));
  const page = Math.ceil(r / rows);
  const result = await fetchRows(query, { rows, page, sort: descending ? "price_desc" : "price_asc" });
  const index = Math.min((r - 1) % rows, result.rows.length - 1);
  const target = result.rows[index];
  if (!target) throw new BlocketError("Blocket returned an empty page for a price lookup; retry.");
  return { rows: result.rows, index, target };
}

/** Number of comparables priced below `price`. */
async function countBelow(params: SearchParams, price: number): Promise<number> {
  if (price <= MIN_PRICE) return 0;
  const query = await buildQuery({ ...params, price_max: Math.min(params.price_max ?? Infinity, price - 1) });
  const { total } = await fetchRows(query, { rows: 1, page: 1, sort: "price_asc" });
  return total;
}

function nearest(window: RankWindow, excludeId: string | undefined): Row[] {
  const start = Math.max(0, Math.min(window.index - Math.floor(EXAMPLES / 2), window.rows.length - EXAMPLES));
  return window.rows
    .slice(start, start + EXAMPLES + 1)
    .filter((row) => row.id !== excludeId)
    .slice(0, EXAMPLES);
}

type Relax = { label: string; apply: (params: SearchParams) => SearchParams };

/**
 * Comparable-ad filters derived from an ad's own specs (Swedish labels as Blocket shows them), plus the order in which
 * they are loosened when too few ads match.
 */
async function comparablesFor(ad: AdDetail): Promise<{ params: SearchParams; relax: Relax[] }> {
  const spec = (pattern: RegExp) => Object.entries(ad.specs).find(([label]) => pattern.test(label))?.[1];
  const number = (value: string | undefined) => {
    const digits = value?.replace(/[^\d]/g, "");
    return digits ? Number(digits) : undefined;
  };
  if (ad.vertical === "torget") return { params: { vertical: "torget", query: ad.title }, relax: [] };

  const make = spec(/^märke$/i);
  const model = spec(/^modell$/i);
  const available = await getFilters(ad.vertical);
  const year = findFilter(available, "year") ? number(spec(/^(modellår|årsmodell|tillverkningsår)$/i)) : undefined;
  const mileage = findFilter(available, "mileage") ? number(spec(/^miltal$/i)) : undefined;
  const feet = Number(spec(/^längd/i)?.match(/(\d+)(?:[.,]\d+)?\s*(?:fot|ft)/i)?.[1]) || undefined;

  const filters: NonNullable<SearchParams["filters"]> = {};
  if (make && !/^övrig/i.test(make)) filters.make = make;
  if (model && ad.vertical !== "boat") filters.model = model;
  if (ad.vertical === "car") {
    const fuel = spec(/^drivmedel$/i);
    const gearbox = spec(/^växellåda$/i);
    if (fuel) filters.fuel = fuel;
    if (gearbox) filters.transmission = gearbox;
  }
  if (ad.vertical === "boat") {
    const type = spec(/^typ$/i);
    if (type) filters.class = type;
    if (feet) filters.length_feet = { min: feet - 2, max: feet + 2 };
  }
  const params: SearchParams = { vertical: ad.vertical, filters };
  const spread = ad.vertical === "car" ? 2 : 3;
  if (year) Object.assign(params, { year_min: year - spread, year_max: year + spread });
  if (mileage) Object.assign(params, { mileage_min_mil: Math.floor(mileage * 0.5), mileage_max_mil: Math.ceil(mileage * 1.5) });

  const dropFilters = (...names: string[]) => (p: SearchParams) => ({
    ...p,
    filters: Object.fromEntries(Object.entries(p.filters ?? {}).filter(([name]) => !names.includes(name))),
  });
  const relax: Relax[] = [];
  if (filters.fuel || filters.transmission) relax.push({ label: "any fuel and gearbox", apply: dropFilters("fuel", "transmission") });
  if (year) relax.push({ label: "model year ±5", apply: (p) => ({ ...p, year_min: year - 5, year_max: year + 5 }) });
  if (feet) relax.push({ label: "length ±4 ft", apply: (p) => ({ ...p, filters: { ...p.filters, length_feet: { min: feet - 4, max: feet + 4 } } }) });
  if (mileage) relax.push({ label: "any mileage", apply: (p) => ({ ...p, mileage_min_mil: undefined, mileage_max_mil: undefined }) });
  if (filters.model) relax.push({ label: "any model of the make", apply: dropFilters("model") });
  if (filters.make && ad.vertical === "boat") relax.push({ label: "any make", apply: dropFilters("make") });
  return { params, relax };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
