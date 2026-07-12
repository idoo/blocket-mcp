// HTTP access to blocket.se's own endpoints (search JSON, ad pages, favourite counters).
// Endpoint knowledge started from github.com/dunderrrrrr/blocket_api (WTFPL); this server calls Blocket directly instead of blocket-api.se.

export const SITE = "https://www.blocket.se";

const HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  "accept-language": "sv-SE,sv;q=0.9",
};

export class BlocketError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BlocketError";
  }
}

async function get(path: string, accept: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(SITE + path, { headers: { ...HEADERS, accept }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new BlocketError(`Blocket did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404 || response.status === 410) throw new BlocketError("Not found on Blocket", response.status);
  if (!response.ok) throw new BlocketError(`Blocket answered HTTP ${response.status} for ${path.split("?")[0]}`, response.status);
  return response;
}

export async function getJson(path: string): Promise<unknown> {
  const response = await get(path, "application/json");
  try {
    return await response.json();
  } catch {
    throw new BlocketError(`Blocket returned invalid JSON for ${path.split("?")[0]}`);
  }
}

export async function getHtml(path: string): Promise<string> {
  return (await get(path, "text/html")).text();
}
