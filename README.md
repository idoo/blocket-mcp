# Blocket MCP

I got tired of scrolling Blocket, so now ChatGPT does it.

It can't log in, message sellers or post anything. It reads public ads and that's it.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black)](https://modelcontextprotocol.io)

## Tools

**search** knows all 13 sections: Torget plus cars, boats, motorcycles, caravans, motorhomes, trucks, tractors, combines, snowmobiles, ATVs, mopeds and buses. You write filters like a person would, `Volvo V70`, `Segelbåt`, `Stockholm`, and the server works out Blocket's ids. Typo in a make? It comes back under `unmatched` with suggestions and the model fixes it on the next call. Without that you'd quietly get every car in Sweden. There's radius search with distances, giveaways and wanted ads, items that ship, "what's new since this morning", one seller's whole stock, and value counts when you want a quick read on the market. Each search also returns its blocket.se URL. Save that in the Blocket app if you want push alerts.

**get_ad** takes up to five ad ids or links. Description, specs, equipment, every photo, whether it's still for sale, who's selling and how many people saved it. It points out the usual scam signs too: pay outside Blocket, "write me on WhatsApp", a foreign number. Dealer cars come with links to their history. Give it several ads and you get a comparison.

**price_check** is for "is this price fair?". It finds comparable live ads by make, model, year, mileage or boat length and gives you p10 to p90 plus where your ad lands. With fewer than 8 comparables it loosens the match and says what it dropped. The numbers are asking prices, since Blocket doesn't show what anything sold for.

**list_filters** lists a section's filters and values with live counts.

## Run your own

ChatGPT and claude.ai can't reach your laptop, so the server needs a public HTTPS address. I run mine on Cloudflare. Firebase works too.

There's no login. ChatGPT's custom connectors offer OAuth or nothing, and OAuth felt like overkill for public ads, so the endpoint hides behind a secret path, `/mcp/<token>`. Any other path gets a 404. Make up a long random token:

```sh
openssl rand -hex 24
```

### Cloudflare Workers

The free plan does fine here.

```sh
git clone https://github.com/idoo/blocket-mcp && cd blocket-mcp
npm ci
npx wrangler login
npx wrangler deploy
npx wrangler secret put MCP_PATH_TOKEN    # paste the token
```

Wrangler prints a workers.dev URL at the end. Stick `/mcp/<token>` on it. There's a limit of 120 calls a minute in `wrangler.jsonc`.

Local dev: `MCP_PATH_TOKEN=dev` in `.dev.vars`, `npm run dev`, then `http://localhost:8787/mcp/dev`.

### Firebase

Cloud Functions need the Blaze plan, which means a card on file. A single person's traffic won't leave the free tier.

```sh
git clone https://github.com/idoo/blocket-mcp && cd blocket-mcp
npm ci && npm --prefix functions ci
firebase login
firebase use --add                              # pick your project
firebase functions:secrets:set MCP_PATH_TOKEN   # paste the token
firebase deploy --only functions
```

The endpoint is `https://europe-north1-<project-id>.cloudfunctions.net/mcp/<token>`. There's no rate limiter on Firebase. The function stops at 3 instances, which keeps the bill small if someone finds your URL. Want another region or more room? Top of `functions/src/index.ts`.

To test without deploying, drop `MCP_PATH_TOKEN=dev` into `functions/.secret.local` and start `firebase emulators:start --only functions`. The URL is `http://127.0.0.1:5001/<project-id>/europe-north1/mcp/dev`.

## Connect

**ChatGPT** on the web: [Plugins](https://chatgpt.com/plugins), Add, "Add custom MCP server". Paste the endpoint, no authentication, done. Then `@Blocket` in any chat. It won't nag for permission on every call because all tools are marked read-only.

**claude.ai**: Settings → Connectors → Add custom connector.

**Claude Code** and **Codex**:

```sh
claude mcp add --transport http blocket https://…/mcp/<token>
codex mcp add blocket --url https://…/mcp/<token>
```

## How it works

Blocket has no public API. The server calls the JSON endpoints that blocket.se's own pages load, usually one request per tool call and a few for comparisons and price checks. Filter names are matched against Blocket's live filter lists, so a make that showed up last week already works. If Blocket changes those endpoints, this breaks until someone patches it. PRs welcome.

The endpoint notes in [dunderrrrrr/blocket_api](https://github.com/dunderrrrrr/blocket_api) got me started. Not affiliated with Blocket AB.

## License

[MIT](LICENSE)
