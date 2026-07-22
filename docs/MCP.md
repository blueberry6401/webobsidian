# MCP endpoint (in-app)

WebObsidian serves the Model Context Protocol directly at `POST /mcp?key=<token>`
(Streamable HTTP, stateless). Connect Claude by pasting
`https://<your-host>/mcp?key=<token>` into claude.ai → Settings → Connectors, or
`claude mcp add webobsidian https://<your-host>/mcp?key=<token>`.

Manage connection keys in **Settings → MCP** (create / revoke; the full URL is
shown once). Keys are stored hashed (SHA-256) in `data/settings.json` under `mcp.keys`,
and are separate from the `wok_` `/api/v1` API keys.

Tools (11): `health_check`, `list_notes`, `read_note`, `search_notes`, `grep_note`,
`list_tags`, `get_backlinks`, `write_note`, `append_note`, `edit_note`, `delete_note`.
The four write/delete tools carry `destructiveHint` so Claude confirms first. The tools
call the in-process vault/search/link services directly (no HTTP hop).

This replaces the standalone Cloudflare Worker (`webobsidian-mcp`), which is retired.

Verify locally: `cd server && ../node_modules/.bin/tsx scripts/verify-mcp.ts` (spawns a
real server + drives a real MCP client through the full tool cycle on a temp vault).
