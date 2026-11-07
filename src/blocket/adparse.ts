// Pure string parsing of blocket.se ad pages (no DOM: runs in Workers and bun alike).
import type { AdDetail, RedFlag, Vertical } from "../types";

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "", ndash: "–", mdash: "—", hellip: "…" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** HTML fragment → plain text keeping line breaks and list bullets. */
export function htmlToText(s: string): string {
  const text = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|li|ul|ol|h\d)>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const inline = (s: string) => htmlToText(s).replace(/\s+/g, " ").trim();

// ---------- Torget ----------

type TorgetItem = {
  title?: string;
  description?: string;
  price?: number | null;
  disposed?: boolean;
  isWebstore?: boolean;
  adViewTypeLabel?: string;
  extras?: { label?: string; value?: unknown }[];
  category?: Category;
  images?: { uri?: string }[];
  location?: { postalCode?: string; postalName?: string; position?: { lat?: number; lng?: number } };
  meta?: { adId?: string; ownerId?: number | string; edited?: string; isInactive?: boolean };
};
type Category = { value?: string; parent?: Category };

export type TorgetParsed = Omit<AdDetail, "red_flags" | "favorites" | "history_links" | "url">;

export function parseTorget(html: string, id: string): TorgetParsed {
  const m = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/);
  if (!m) throw new Error("Torget page without hydration data");
  // The payload is a JS string literal holding JSON: parse twice.
  const data = JSON.parse(JSON.parse(m[1]) as string) as { loaderData?: Record<string, Record<string, unknown>> };
  const page = data.loaderData?.["item-recommerce"];
  const item = page?.itemData as TorgetItem | undefined;
  if (!item?.title) throw new Error("Torget page without item data");
  const tx = (page?.transactableData ?? {}) as { buyNow?: boolean; eligibleForShipping?: boolean; sellerPaysShipping?: boolean };
  const shop = page?.shopProfileData as { name?: string; title?: string } | null | undefined;

  const specs: Record<string, string> = {};
  for (const e of item.extras ?? []) {
    const value = Array.isArray(e.value) ? e.value.join(", ") : e.value;
    if (e.label && (typeof value === "string" || typeof value === "number") && String(value).trim()) specs[e.label] = String(value).trim();
  }
  const path: string[] = [];
  for (let c = item.category; c; c = c.parent) if (c.value) path.unshift(c.value);
  if (path.length) specs.Kategori = path.join(" › ");
  if (item.adViewTypeLabel) specs.Annonstyp = item.adViewTypeLabel;

  const loc = item.location;
  const ownerId = item.meta?.ownerId;
  const dealer = item.isWebstore === true || !!shop;
  const shopName = shop?.name ?? shop?.title;
  return {
    id,
    vertical: "torget",
    title: item.title,
    price: typeof item.price === "number" ? item.price : null,
    status: item.disposed ? "sold" : item.meta?.isInactive ? "removed" : "active",
    ...(item.description?.trim() ? { description: item.description.trim() } : {}),
    specs,
    images: (item.images ?? []).map((i) => i.uri).filter((u): u is string => !!u),
    place: {
      ...(loc?.postalName ? { city: loc.postalName } : {}),
      ...(loc?.postalCode ? { postal_code: loc.postalCode } : {}),
      // Shops publish 0,0 when they hide the position.
      ...(loc?.position?.lat && loc.position.lng ? { lat: loc.position.lat, lon: loc.position.lng } : {}),
    },
    ...(item.meta?.edited ? { edited: item.meta.edited } : {}),
    seller: {
      type: dealer ? "dealer" : "private",
      ...(dealer && shopName ? { name: shopName } : {}),
      ...(ownerId != null ? { id: String(ownerId) } : {}),
    },
    shipping: { can_ship: tx.eligibleForShipping === true, buy_now: tx.buyNow === true, seller_pays: tx.sellerPaysShipping === true },
  };
}

// ---------- Vehicles (mobility) ----------

const VIEW_TYPES: [RegExp, Vertical][] = [
  [/^car/, "car"],
  [/^boat/, "boat"],
  [/^(motorcycle|mc)/, "mc"],
  [/^caravan/, "caravan"],
  [/^mobile-home/, "motorhome"],
  [/^truck/, "truck"],
  [/^agriculture-thresh|combine/, "combine"],
  [/^agriculture/, "tractor"],
  [/^snowmobile/, "snowmobile"],
  [/^atv/, "atv"],
  [/^moped|scooter/, "moped"],
  [/^bus/, "bus"],
];

const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

/** "5 november 2026, 20:33" (Stockholm local time) → ISO with offset. */
function swedishDate(s: string): string | undefined {
  const m = s.match(/(\d{1,2})\s+([a-zåäö]+)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/i);
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (!m || month < 0) return undefined;
  const p2 = (n: number | string) => String(n).padStart(2, "0");
  const local = `${m[3]}-${p2(month + 1)}-${p2(m[1])}T${p2(m[4])}:${m[5]}`;
  const offset = new Intl.DateTimeFormat("en", { timeZone: "Europe/Stockholm", timeZoneName: "longOffset" })
    .formatToParts(new Date(`${local}:00Z`))
    .find((p) => p.type === "timeZoneName")
    ?.value.replace("GMT", "");
  return `${local}:00${offset || "+01:00"}`;
}

/** Text between the h2 heading `title` and the end of its section. */
function section(html: string, title: string, end: string): string | undefined {
  const start = html.search(new RegExp(`<h2[^>]*>\\s*${title}\\s*</h2>`));
  if (start < 0) return undefined;
  const stop = html.indexOf(end, start);
  return html.slice(start, stop < 0 ? start + 20_000 : stop);
}

export type VehicleParsed = Omit<AdDetail, "red_flags" | "favorites" | "history_links" | "url"> & { regno?: string };

/** "204 Hk", "75,5 kWh", "231 840 kr" → the number, when the value ends in `unit` (case-insensitive). */
function unitNumber(value: string | undefined, unit: string): number | undefined {
  const m = value?.replace(/[\s\u00a0]/g, "").match(new RegExp(`^(\\d+(?:[,.]\\d+)?)${unit}$`, "i"));
  if (!m) return undefined;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

export function parseVehicle(html: string, id: string): VehicleParsed {
  let product: Record<string, unknown> | undefined;
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]) as Record<string, unknown>;
      if (j["@type"] === "Product") product = j;
    } catch {
      // other JSON-LD blocks may be malformed; Product is what matters
    }
  }
  // Ad-targeting key/values carry owner type, org id and the full image list.
  const kv: Record<string, string[]> = {};
  for (const m of html.matchAll(/\{"key":"([a-z_0-9]+)","value":\[((?:"[^"]*",?)*)\]\}/g)) {
    if (!kv[m[1]]) kv[m[1]] = [...m[2].matchAll(/"([^"]*)"/g)].map((v) => v[1]);
  }

  const viewType = html.match(/"adViewType":"([^"]+)"/)?.[1] ?? "";
  const vertical = VIEW_TYPES.find(([re]) => re.test(viewType))?.[1];
  if (!vertical) throw new Error(`Unknown Blocket vehicle page type "${viewType}"`);

  const title = (product?.name as string | undefined) ?? kv.ad_title?.[0] ?? inline(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!title) throw new Error("Vehicle page without title");
  const offers = (product?.offers ?? {}) as { price?: number | string; availability?: string };
  const priceRaw = offers.price ?? kv.price?.[0];
  const price = priceRaw != null && priceRaw !== "" && Number.isFinite(Number(priceRaw)) ? Number(priceRaw) : null;

  const descSection = section(html, "Beskrivning", "</section>");
  const descStart = descSection?.indexOf("whitespace-pre-wrap") ?? -1;
  let description: string | undefined;
  if (descSection && descStart >= 0) {
    const body = descSection.slice(descSection.indexOf(">", descStart) + 1).split("<w-button")[0];
    description = htmlToText(body) || undefined;
  }

  const specs: Record<string, string> = {};
  const specSection = section(html, "Specifikationer", "</dl>");
  for (const m of specSection?.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g) ?? []) {
    // Info tooltips (<w-attention>) sit inside the label markup.
    const label = inline(m[1].replace(/<w-attention[\s\S]*?<\/w-attention>/g, ""));
    const value = inline(m[2].replace(/<w-attention[\s\S]*?<\/w-attention>/g, ""));
    if (label && value) specs[label] = value;
  }

  const equipSection = section(html, "Utrustning", "</ul>");
  const equipment = [...(equipSection?.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g) ?? [])].map((m) => inline(m[1])).filter(Boolean);

  const ldImages = Array.isArray(product?.image)
    ? (product.image as { contentUrl?: string }[]).map((i) => i.contentUrl).filter((u): u is string => !!u)
    : [];
  const images = kv.images?.length ? [...new Set(kv.images)] : ldImages;

  // "Plats" section: "Street 1, 41705 Göteborg" or "79170 Falun".
  const placeText = inline(section(html, "Plats", "</section>")?.match(/<span[^>]*>([\s\S]*?)<w-icon/)?.[1] ?? "");
  const pm = placeText.match(/(\d{3}\s?\d{2})\s+(.+)$/);
  const postal = pm?.[1].replace(/\s/g, "") ?? kv.zipcode?.[0];

  const dealerIdx = html.indexOf("Återförsäljarens uppgifter");
  const dealer = dealerIdx >= 0 || kv.owner_type?.[0] === "professional";
  const dealerBlock = dealerIdx >= 0 ? html.slice(dealerIdx, dealerIdx + 15_000) : "";
  const dealerName = dealerBlock.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? html.match(/Säljs av<\/[^>]+>\s*(?:<[^>]+>\s*)*([^<]+)</)?.[1];
  const pageText = inline(html);
  const memberSince = pageText.match(/(\d+\+?\s*år på Blocket)/)?.[1];
  // Dealer star rating: "4,3" then stars then a Google Maps link "420 omdömen".
  const ratingMatch = dealerBlock.match(/<span[^>]*>\s*(\d(?:,\d+)?)\s*<\/span>(?:(?!<\/h3>|<h2)[\s\S]){0,4000}?<a[^>]*href="https:\/\/www\.google\.[^"]*"[^>]*>\s*([\d\s\u00a0]+)\s*omdömen\s*<\/a>/);
  const rating = ratingMatch
    ? { score: Number(ratingMatch[1].replace(",", ".")), count: Number(ratingMatch[2].replace(/\D/g, "")), scale: 5, source: "google" as const }
    : undefined;
  const adCount = html.match(/Visa handlarens\s+([\d\s\u00a0]+)\s+annonser/)?.[1].replace(/\D/g, "");
  const orgId = kv.org_id?.[0];

  const updated = html.match(/>Uppdaterad<\/p>\s*<p[^>]*>([^<]+)</)?.[1];
  const edited = updated ? swedishDate(decodeEntities(updated)) : undefined;

  const regno = specs.Registreringsnummer ?? specs.Regnummer ?? kv.regno?.[0];
  const horsepower = unitNumber(specs.Effekt ?? specs.Motorstorlek, "hk");
  const rangeKm = unitNumber(specs["Räckvidd (WLTP)"] ?? specs["Räckvidd"], "km");
  const batteryKwh = unitNumber(specs.Batterikapacitet, "kWh");
  const exVat = unitNumber(pageText.match(/\(([\d\s]+kr) exkl\. moms\)/)?.[1], "kr");
  const vehicle = {
    ...(horsepower != null ? { horsepower } : {}),
    ...(rangeKm != null ? { range_km: rangeKm } : {}),
    ...(batteryKwh != null ? { battery_kwh: batteryKwh } : {}),
    ...(exVat != null ? { vat_deductible: true, price_excl_vat: exVat } : {}),
  };
  const avail = offers.availability ?? "";
  return {
    id,
    vertical,
    title: decodeEntities(title),
    price,
    status: /SoldOut|OutOfStock|Discontinued/i.test(avail) ? "sold" : "active",
    ...(description ? { description } : {}),
    specs,
    ...(equipment.length ? { equipment } : {}),
    images,
    place: {
      ...(pm?.[2] ? { city: pm[2].trim() } : {}),
      ...(postal ? { postal_code: postal } : {}),
    },
    ...(edited ? { edited } : {}),
    seller: {
      type: dealer ? "dealer" : "private",
      ...(dealer && dealerName ? { name: inline(dealerName) } : {}),
      ...(orgId ? { id: orgId } : {}),
      ...(memberSince ? { member_since: memberSince } : {}),
      ...(adCount ? { ad_count: Number(adCount) } : {}),
      ...(dealer && placeText ? { address: placeText } : {}),
      ...(dealer && rating && rating.score > 0 && rating.count > 0 ? { rating } : {}),
    },
    ...(Object.keys(vehicle).length ? { vehicle } : {}),
    ...(regno ? { regno } : {}),
  };
}

// ---------- Red flags ----------

/** Vehicles that carry a Swedish registration number. */
const REGISTERED: Vertical[] = ["car", "mc", "caravan", "motorhome", "truck", "bus", "moped", "snowmobile", "atv", "tractor"];
const HIGH_VALUE_SEK = 5000;

type FlagInput = Omit<AdDetail, "red_flags" | "favorites" | "history_links" | "url"> & { regno?: string };
type FlagRule = { level: RedFlag["level"]; check: (ad: FlagInput, text: string) => string | undefined };

const matchText = (re: RegExp, msg: (hit: string) => string) => (_: FlagInput, text: string) => {
  const hit = text.match(re)?.[0];
  return hit ? msg(hit.trim()) : undefined;
};

/** One list: add a rule here to add a flag. Texts state facts, never verdicts. */
export const RED_FLAG_RULES: FlagRule[] = [
  {
    level: "warn",
    check: matchText(
      /swish\w*\s+(?:i\s+)?förskott|förskottsbetal\w*|betal\w*\s+(?:i\s+)?förskott|betala\s+innan|betalning\s+innan|western\s*union|moneygram|paypal\s+(?:friends|vänner|f&f)|friends\s*(?:and|&)\s*family/i,
      (hit) => `Description mentions payment outside Blocket ("${hit}").`,
    ),
  },
  { level: "warn", check: matchText(/whats\s?app|telegram/i, (hit) => `Description asks to move contact to ${hit}.`) },
  {
    level: "warn",
    check: matchText(/(?<![\d+])(?:\+|00)(?!46)[1-9]\d{0,2}[\s-]?\d[\d\s-]{6,}\d/, (hit) => `Description contains a foreign phone number (${hit}).`),
  },
  {
    level: "warn",
    check: (ad, text) => {
      const hit = text.match(/endast\s+frakt|bara\s+frakt|skickas\s+endast|säljs\s+endast\s+med\s+frakt|kan\s+(?:ej|inte)\s+hämtas|ingen\s+upphämtning/i)?.[0];
      return hit && (ad.price ?? 0) >= HIGH_VALUE_SEK ? `Shipping only ("${hit}") on a ${ad.price} kr item: no inspection before paying.` : undefined;
    },
  },
  { level: "warn", check: (ad) => (ad.status !== "active" ? `Ad is marked ${ad.status} on Blocket.` : undefined) },
  {
    level: "info",
    check: (ad) =>
      ad.vertical === "torget" && (ad.price ?? 0) >= HIGH_VALUE_SEK && ad.shipping && !ad.shipping.buy_now
        ? `${ad.price} kr item without Blocket buy-now (protected payment)${ad.shipping.can_ship ? "" : " or Blocket shipping"}.`
        : undefined,
  },
  {
    level: "info",
    check: (ad) =>
      REGISTERED.includes(ad.vertical) && !ad.regno
        ? "Registration number not shown on the ad page; ask the seller for it to check the vehicle's history."
        : undefined,
  },
  {
    level: "info",
    check: (ad) =>
      ad.seller.type === "private" && (ad.seller.ad_count ?? 0) >= 10 ? `Private seller with ${ad.seller.ad_count} active ads.` : undefined,
  },
];

export function redFlags(ad: FlagInput): RedFlag[] {
  const text = `${ad.title}\n${ad.description ?? ""}`;
  const flags: RedFlag[] = [];
  for (const rule of RED_FLAG_RULES) {
    const msg = rule.check(ad, text);
    if (msg) flags.push({ level: rule.level, text: msg });
  }
  return flags;
}
