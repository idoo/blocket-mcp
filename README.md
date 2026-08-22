# Blocket MCP

I got tired of scrolling Blocket, so now ChatGPT does it.

It can't log in, message sellers or post anything. It reads public ads and that's it.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black)](https://modelcontextprotocol.io)

## Run your own

ChatGPT and claude.ai can't reach your laptop, so the server needs a public HTTPS address. I run mine on Cloudflare.

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

## Connect

**ChatGPT** on the web: [Plugins](https://chatgpt.com/plugins), Add, "Add custom MCP server". Paste the endpoint, no authentication, done. Then `@Blocket` in any chat. It won't nag for permission on every call because all tools are marked read-only.

**claude.ai**: Settings → Connectors → Add custom connector.

**Claude Code** and **Codex**:

```sh
claude mcp add --transport http blocket https://…/mcp/<token>
codex mcp add blocket --url https://…/mcp/<token>
```

## How it works

Blocket has no public API. The server calls the JSON endpoints that blocket.se's own pages load, usually one request per tool call and a few for comparisons. Filter names are matched against Blocket's live filter lists, so a make that showed up last week already works. If Blocket changes those endpoints, this breaks until someone patches it. PRs welcome.

The endpoint notes in [dunderrrrrr/blocket_api](https://github.com/dunderrrrrr/blocket_api) got me started. Not affiliated with Blocket AB.

## License

[MIT](LICENSE)
