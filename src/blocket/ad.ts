// get_ad: one or several Blocket ads (Torget and vehicles) with seller, shipping, red flags and history links.
import type { AdDetail, AdsResult } from "../types";
import { BlocketError, SITE, getHtml, getJson } from "./http";
import { parseTorget, parseVehicle, redFlags, type VehicleParsed } from "./adparse";

const MAX_ADS = 5;
type Kind = "torget" | "vehicle";

function parseInput(idOrUrl: string): { id: string; kind?: Kind } {
  const s = idOrUrl.trim();
  if (/^\d+$/.test(s)) return { id: s };
  if (!/blocket\.se/i.test(s)) throw new BlocketError(`"${s}" is not a Blocket ad id or blocket.se URL`);
  const torget = s.match(/\/recommerce\/[^?#]*\/item\/(\d+)/);
  if (torget) return { id: torget[1], kind: "torget" };
  const vehicle = s.match(/\/mobility\/[^?#]*item\/(\d+)/);
  if (vehicle) return { id: vehicle[1], kind: "vehicle" };
  const any = s.match(/[?&]adId=(\d+)/) ?? s.match(/\/(\d{5,})(?:[/?#]|$)/);
  if (any) return { id: any[1] };
  throw new BlocketError(`No ad id found in "${s}"`);
}

async function favorites(id: string): Promise<number | undefined> {
  try {
    const j = (await getJson(`/favorite-frontend-api/Ad/${id}/counter`)) as { counter?: unknown };
    return typeof j.counter === "number" ? j.counter : undefined;
  } catch {
    return undefined;
  }
}

type Page = { url: string; parsed: VehicleParsed };

async function fetchKind(id: string, kind: Kind): Promise<Page> {
  const path = kind === "torget" ? `/recommerce/forsale/item/${id}` : `/mobility/item/${id}`;
  const html = await getHtml(path);
  return { url: SITE + path, parsed: kind === "torget" ? parseTorget(html, id) : parseVehicle(html, id) };
}

export async function getAd(idOrUrl: string): Promise<AdDetail> {
  const { id, kind } = parseInput(idOrUrl);
  const favoritesP = favorites(id);
  let page: Page;
  if (kind) {
    page = await fetchKind(id, kind);
  } else {
    // Bare ids: Torget first; Blocket answers 404 on the wrong path, then try vehicles.
    try {
      page = await fetchKind(id, "torget");
    } catch (error) {
      if (!(error instanceof BlocketError && error.status === 404)) throw error;
      try {
        page = await fetchKind(id, "vehicle");
      } catch (error2) {
        if (error2 instanceof BlocketError && error2.status === 404) throw new BlocketError(`Ad ${id} not found on Blocket (no Torget or vehicle ad)`, 404);
        throw error2;
      }
    }
  }
  const { regno, ...parsed } = page.parsed;
  const fav = await favoritesP;
  return {
    ...parsed,
    ...(fav != null ? { favorites: fav } : {}),
    red_flags: redFlags({ ...parsed, regno }),
    ...(regno
      ? {
          history_links: [
            { label: "car.info", url: `https://www.car.info/sv-se/license-plate/S/${encodeURIComponent(regno)}` },
            { label: "biluppgifter.se", url: `https://biluppgifter.se/fordon/${encodeURIComponent(regno)}` },
          ],
        }
      : {}),
    url: page.url,
  };
}

export async function getAds(idsOrUrls: string[]): Promise<AdsResult> {
  const inputs = idsOrUrls.slice(0, MAX_ADS);
  const settled = await Promise.allSettled(inputs.map((x) => getAd(x)));
  const result: AdsResult = { ads: [], errors: [] };
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") result.ads.push(r.value);
    else result.errors.push({ id: inputs[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  for (const extra of idsOrUrls.slice(MAX_ADS)) result.errors.push({ id: extra, error: `At most ${MAX_ADS} ads per call` });
  return result;
}
