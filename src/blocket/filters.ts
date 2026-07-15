// Blocket filter metadata: cached per vertical, used to turn human labels ("Volvo V70", "Stockholm", "Segelbåt") into Blocket ids.

import type { FilterInfo, FiltersResult, Vertical } from "../types";
import { BlocketError, getJson } from "./http";
import { VERTICAL_CONFIG } from "./verticals";

export type FilterItem = { display_name: string; value: string; hits?: number; filter_items?: FilterItem[] };
export type BlocketFilter = {
  name: string;
  display_name: string;
  type: string;
  filter_items?: FilterItem[];
  name_from?: string;
  name_to?: string;
  min_value?: number;
  max_value?: number;
  unit?: string;
};

/** One value in a flattened filter tree. `path` joins ancestor labels with spaces ("Volvo V70", "Stockholm Nacka"). */
export type FilterNode = { label: string; path: string; value: string; hits: number; depth: number };

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<Vertical, { at: number; filters: BlocketFilter[] }>();

/** Filters a caller can set through `filters` (free text and map filters have their own params). */
export function parseFilters(json: unknown): BlocketFilter[] {
  const list = json && typeof json === "object" && "filters" in json && Array.isArray(json.filters) ? (json.filters as BlocketFilter[]) : [];
  return list.filter((f) => f.type === "STANDARD_FILTER" || f.type === "RANGE_FILTER");
}

export async function getFilters(vertical: Vertical): Promise<BlocketFilter[]> {
  const hit = cache.get(vertical);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.filters;
  const filters = parseFilters(await getJson(`${VERTICAL_CONFIG[vertical].apiPath}?rows=1&include_filters=true`));
  if (!filters.length) throw new BlocketError(`Blocket returned no filter list for ${vertical}`);
  cache.set(vertical, { at: Date.now(), filters });
  return filters;
}

export function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function flatten(items: FilterItem[] | undefined, depth = 0, parent = ""): FilterNode[] {
  const out: FilterNode[] = [];
  for (const item of items ?? []) {
    const path = parent ? `${parent} ${item.display_name}` : item.display_name;
    out.push({ label: item.display_name, path, value: String(item.value), hits: item.hits ?? 0, depth });
    out.push(...flatten(item.filter_items, depth + 1, path));
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Closest labels (by edit distance against label or path), most hits first among equals. */
export function suggest(input: string, candidates: { label: string; hits?: number }[], limit = 5): string[] {
  const n = norm(input);
  const scored = candidates.map((c) => {
    const l = norm(c.label);
    return { label: c.label, hits: c.hits ?? 0, d: Math.min(levenshtein(n, l), levenshtein(n, l.slice(0, n.length)) + 1) };
  });
  scored.sort((a, b) => a.d - b.d || b.hits - a.hits);
  return [...new Set(scored.map((s) => s.label))].slice(0, limit);
}

/** Shown label for a node: model rows of the car make→model tree read better with their make. */
export function nodeLabel(filter: BlocketFilter, node: FilterNode): string {
  return filter.name === "variant" && node.depth > 0 ? node.path : node.label;
}

/**
 * Resolves one human value (or raw Blocket id) against a STANDARD filter.
 * Exact label/path match first, then prefix, then substring, then every input word present in the path
 * ("Volkswagen Golf I" → "Volkswagen Golf-Serie Golf I"); ties go to the shallowest value with most hits.
 */
export function resolveValue(filter: BlocketFilter, input: string): { value: string; label: string } | { suggestions: string[] } {
  const nodes = flatten(filter.filter_items);
  const raw = nodes.find((x) => x.value === input.trim());
  if (raw) return { value: raw.value, label: nodeLabel(filter, raw) };
  const n = norm(input);
  if (n) {
    const tiers: ((x: FilterNode) => boolean)[] = [
      (x) => norm(x.label) === n || norm(x.path) === n,
      (x) => norm(x.label).startsWith(n) || norm(x.path).startsWith(n),
      (x) => norm(x.path).includes(n),
      (x) => {
        const words = new Set(norm(x.path).split(" "));
        return n.split(" ").every((word) => words.has(word));
      },
    ];
    for (const test of tiers) {
      const found = nodes.filter(test).sort((a, b) => a.depth - b.depth || b.hits - a.hits)[0];
      if (found) return { value: found.value, label: nodeLabel(filter, found) };
    }
  }
  return { suggestions: suggest(input, nodes.map((x) => ({ label: nodeLabel(filter, x), hits: x.hits }))) };
}

/** Our generic names → this vertical's Blocket filter name (car makes live in the `variant` make→model tree). */
export function findFilter(filters: BlocketFilter[], name: string): BlocketFilter | undefined {
  const exact = filters.find((f) => f.name === name);
  if (exact) return exact;
  const n = norm(name);
  const alias: Record<string, string[]> = {
    make: ["variant", "brand"],
    model: ["variant"],
    brand: ["make"],
    place: ["location"],
    places: ["location"],
    seller: ["dealer_segment", "caravan_dealer_segment"],
    dealer_segment: ["caravan_dealer_segment"],
    condition: ["mc_condition", "caravancondition", "mobilehomecondition"],
  };
  for (const target of alias[name] ?? []) {
    const f = filters.find((x) => x.name === target);
    if (f) return f;
  }
  return filters.find((f) => norm(f.display_name) === n);
}

export function rangeInfo(f: BlocketFilter): { min: number; max: number; unit?: string } {
  return { min: f.min_value ?? 0, max: f.max_value ?? 0, ...(f.unit ? { unit: f.unit } : {}) };
}

export async function listFilters(vertical: Vertical, filter?: string, query?: string): Promise<FiltersResult> {
  const all = await getFilters(vertical);
  let chosen = all;
  if (filter) {
    const f = findFilter(all, filter);
    if (!f) throw new BlocketError(`No filter "${filter}" for ${vertical}. Filters: ${all.map((x) => x.name).join(", ")}`);
    chosen = [f];
  }
  const q = query ? norm(query) : "";
  const out: FilterInfo[] = [];
  for (const f of chosen) {
    if (f.type === "RANGE_FILTER") {
      if (!q) out.push({ name: f.name, label: f.display_name, kind: "range", range: rangeInfo(f) });
      continue;
    }
    const nodes = flatten(f.filter_items);
    const pool = q ? nodes.filter((x) => norm(x.path).includes(q)) : nodes.filter((x) => x.depth === 0);
    if (q && !pool.length) continue;
    pool.sort((a, b) => b.hits - a.hits);
    const limit = q ? 50 : 30;
    const info: FilterInfo = {
      name: f.name,
      label: f.display_name,
      kind: "values",
      values: pool.slice(0, limit).map((x) => ({ label: nodeLabel(f, x), count: x.hits })),
    };
    if (pool.length > limit) info.total_values = pool.length;
    out.push(info);
  }
  return { vertical, filters: out };
}
