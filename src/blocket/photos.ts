// get_ad_photos: a few of an ad's photos as small base64 JPEGs so the model can look at them.
import { getAd } from "./ad";

const DEFAULT_PHOTOS = 4;
const MAX_PHOTOS = 8;
const MAX_BYTES = 200_000;

export type AdPhoto = { index: number; url: string; mimeType: string; data: string };
export type AdPhotos = { id: string; title: string; url: string; total_photos: number; photos: AdPhoto[] };

/**
 * images.blocketcdn.se serves /dynamic/{variant}/item/... with variants 320w, 480w, 640w, 960w, 1280w, 1600w
 * (width in px) and "default" (longest side 575 px). 640w is about 30-90 KB.
 */
const variant = (url: string, v: string) => url.replace(/(images\.blocketcdn\.se\/dynamic\/)[^/]+\//, `$1${v}/`);

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function fetchImage(url: string): Promise<{ mimeType: string; bytes: Uint8Array } | undefined> {
  try {
    // Ask for JPEG: with a browser Accept header the CDN answers AVIF, which few MCP clients render.
    const r = await fetch(url, { headers: { accept: "image/jpeg,image/png;q=0.9" }, signal: AbortSignal.timeout(15_000) });
    const mimeType = r.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (!r.ok || !mimeType.startsWith("image/")) return undefined;
    return { mimeType, bytes: new Uint8Array(await r.arrayBuffer()) };
  } catch {
    return undefined;
  }
}

async function photo(index: number, original: string): Promise<AdPhoto | undefined> {
  const small = variant(original, "640w");
  let got = await fetchImage(small);
  // Very tall or noisy photos can exceed the budget at 640w: fall back to the smaller "default" variant.
  if (got && got.bytes.length > MAX_BYTES && small !== original) got = (await fetchImage(variant(original, "default"))) ?? got;
  if (!got && small !== original) got = await fetchImage(original);
  if (!got) return undefined;
  return { index, url: original, mimeType: got.mimeType, data: toBase64(got.bytes) };
}

export async function getAdPhotos(idOrUrl: string, max: number = DEFAULT_PHOTOS): Promise<AdPhotos> {
  const ad = await getAd(idOrUrl);
  const n = Math.min(MAX_PHOTOS, Math.max(1, Math.floor(Number.isFinite(max) ? max : DEFAULT_PHOTOS)));
  const settled = await Promise.all(ad.images.slice(0, n).map((u, i) => photo(i, u)));
  return {
    id: ad.id,
    title: ad.title,
    url: ad.url,
    total_photos: ad.images.length,
    photos: settled.filter((p): p is AdPhoto => !!p),
  };
}
