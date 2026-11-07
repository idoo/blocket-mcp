# Local stdio server: docker build -t blocket-mcp .
#                     docker run -i --rm blocket-mcp
# Published image:    ghcr.io/idoo/blocket-mcp (built by .github/workflows/release.yml).
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS build
WORKDIR /src
COPY package.json package-lock.json ./
# esbuild ships its binary as an optional dependency; no install scripts are needed.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:stdio

FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
LABEL io.modelcontextprotocol.server.name="io.github.idoo/blocket-mcp"
LABEL org.opencontainers.image.source="https://github.com/idoo/blocket-mcp"
LABEL org.opencontainers.image.description="Read-only MCP server for Blocket.se listings (stdio)"
LABEL org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --from=build /src/dist/blocket-mcp.js /app/blocket-mcp.js
USER node
ENTRYPOINT ["node", "/app/blocket-mcp.js"]
