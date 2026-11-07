# Security

Report a vulnerability privately through [GitHub's private vulnerability reporting](https://github.com/idoo/blocket-mcp/security/advisories/new). Please don't open a public issue for it.

What counts: anything that lets someone use a hosted endpoint without its path token, run code on the host, read the host's secrets, or make the server send requests anywhere other than blocket.se and images.blocketcdn.se.

The server only reads public Blocket pages. It has no accounts, stores nothing and needs no API keys.
