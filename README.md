# Blocket MCP

MCP server that lets ChatGPT, Claude and other clients search Blocket.se, open ads and check whether an asking price makes sense. It knows Torget and all twelve vehicle sections, from cars and boats to combines and snowmobiles.

Read-only. No account or API key.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black)](https://modelcontextprotocol.io)

## Tools

- `search` takes filters in plain words like `Volvo V70`, `Segelbåt` or `Stockholm` and looks up Blocket's ids itself. A misspelled make comes back with suggestions. `exclude: ["skal", "laddare", "köpes"]` clears phone cases, chargers and wanted ads out of an iPhone search, and `deals` rates every ad against the median price of the same search.
- `get_ad` opens up to five ads in full, seller included. If the text wants Swish up front, moves you to WhatsApp or has a foreign number in it, you'll hear about it. Vehicles with a visible reg number get car.info and biluppgifter links. Several ads come back side by side.
- `get_ad_photos` hands the model up to 8 photos of an ad. If it can see, it can spot the rust the seller forgot to mention.
- `price_check` pulls live ads for the same make and model, close in year and mileage, or boats of about the same length. You get p10 to p90 and the spot where your ad lands. Give it `new_price` (from [Billigast](https://github.com/idoo/billigast-mcp), say) and it also shows what share of the shop price people ask. Blocket hides sold prices, so these are asking prices.
- `list_filters` lists a section's filters with live counts.

ChatGPT shows the results as cards with photos.

## Local

For Claude Desktop there's a `.mcpb` file under [Releases](https://github.com/idoo/blocket-mcp/releases). Double-click it and it installs.

Anything else can run it in Docker:

```sh
claude mcp add blocket -- docker run -i --rm ghcr.io/idoo/blocket-mcp
```

Without Docker, Node 20 or newer works too:

```sh
npm ci && npm run build:stdio
node dist/blocket-mcp.js
```

## ChatGPT, claude.ai

ChatGPT and claude.ai won't talk to your laptop. I host mine on a Cloudflare Worker, free plan:

```sh
npm ci && npx wrangler deploy
npx wrangler secret put MCP_PATH_TOKEN    # openssl rand -hex 24
```

Paste `https://<your worker>.workers.dev/mcp/<token>` as the URL. The token is the only lock, so make it long. Other paths return 404, and `wrangler.jsonc` caps calls at 120 a minute. ChatGPT: Plugins, Add custom MCP server, no auth. claude.ai: Settings, Connectors.

Firebase works as well if you're on the Blaze plan:

```sh
npm ci && npm --prefix functions ci
firebase login && firebase use --add
firebase functions:secrets:set MCP_PATH_TOKEN
firebase deploy --only functions
```

Your URL is `https://europe-north1-<project-id>.cloudfunctions.net/mcp/<token>`. Firebase has no rate limiter, so the function stops at 3 instances. Region and limits are at the top of `functions/src/index.ts`.

## Caveats

Blocket has no public API. The server calls the JSON endpoints blocket.se's own pages load, so when Blocket changes them this breaks until someone patches it. Filters are matched against Blocket's live lists, and a make that appeared last week already works.

The endpoint notes in [dunderrrrrr/blocket_api](https://github.com/dunderrrrrr/blocket_api) got me started. Not affiliated with Blocket AB. [MIT](LICENSE).
