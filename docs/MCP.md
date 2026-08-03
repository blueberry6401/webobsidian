# MCP endpoint (in-app)

WebObsidian serves the Model Context Protocol directly at `POST /mcp?key=<token>`
(Streamable HTTP, stateless). Connect Claude by pasting
`https://<your-host>/mcp?key=<token>` into claude.ai → Settings → Connectors, or
`claude mcp add webobsidian https://<your-host>/mcp?key=<token>`.

Manage connection keys in **Settings → MCP** (create / revoke; the full URL is
shown once). Keys are stored hashed (SHA-256) in `data/settings.json` under `mcp.keys`,
and are separate from the `wok_` `/api/v1` API keys.

Per-note tools (11): `health_check`, `list_notes`, `read_note`, `search_notes`, `grep_note`,
`list_tags`, `get_backlinks`, `write_note`, `append_note`, `edit_note`, `delete_note`.
The four write/delete tools carry `destructiveHint` so Claude confirms first. The tools
call the in-process vault/search/link services directly (no HTTP hop). `list_notes`
accepts `sort` (`name` | `modified` | `created`) + `order` (`asc` | `desc`), defaulting
to `modified`/`desc` (most-recently-edited first) so new notes never fall past `limit`.

This replaces the standalone Cloudflare Worker (`webobsidian-mcp`), which is retired.

## Bulk file transfer (4 tools, 15 total)

`download_files`, `upload_from_url`, `upload_files`, `transfer_status` move whole sets of
files — **including binary attachments** — in one call. The transfer unit is a **ZIP moved
over plain HTTP, outside the MCP channel**: a tool only ever hands back a *link*, never the
*bytes*. Anything inside a tool's arguments or result is model tokens (a 5 MB zip base64s to
~6.7 MB of text), so keeping bytes out of the MCP channel is what makes hundred-MB vault
transfers possible at all.

**Vault A → vault B, fully automatic** (no human step):

```
A.download_files({folder: "Projects"})   → https://A/transfer/d/<token>
B.upload_from_url({url: "<that link>"})  → server B fetches it, unzips into the vault
```

**Files on your own disk** → `upload_files` returns a link *you* open in a browser and drop a
zip onto, then `transfer_status({ticket})` reports what landed. This path cannot be automated
from claude.ai — that client runs in Anthropic's datacenter and has no route to your disk.

`on_conflict` is `rename` (default, `note.md` → `note (1).md`), `overwrite`, or `skip`.
`download_files` skips `.trash` and dotfiles (`.obsidian`, `.git`), and caps at 5 000 files /
500 MB.

### HTTP surface — `/transfer/*` (NO auth, 256-bit token in the URL)

```
GET  /transfer/d/{token}   # download the zip (reusable within TTL)
GET  /transfer/u/{token}   # SSR drag-and-drop page
POST /transfer/u/{token}   # multipart 'file' → unzip into the vault; SINGLE USE
```

Tickets live in memory (not `settings.json` — they are ephemeral) with a **30-minute TTL**.

### Gotcha: `/transfer` must be excluded from the SPA catch-all

Exactly the same trap as the OAuth-discovery paths below. `app.get('*')` in
`server/src/index.ts` answers unknown paths with the SPA's **200 HTML**; without `/transfer`
in its exclusion list the download link serves HTML instead of a zip and the drag-and-drop
page never renders. Note this only bites once the SPA is built — `server/public` missing means
the catch-all is never mounted, so a test run before `npm run build` passes for the wrong
reason. `verify-mcp.ts` therefore asserts the catch-all *is* live before trusting those checks.

### Security

Zip-slip guard rejects entries that are absolute, contain `..` or NUL, or target
`.trash`/`.git`; **symlink entries are skipped entirely** (a symlink pointing at `/etc` would
turn the next write into a system-file overwrite). Zip-bomb ceiling: 10 000 entries / 2 GB.
`upload_from_url` has an SSRF guard — http/https only, address checked **at connect time**
(defeats DNS rebinding) *and* separately for IP literals, because **Node skips the `lookup`
hook when the hostname is already numeric**, which would otherwise let `http://169.254.169.254`
(the cloud metadata endpoint, always addressed by literal IP) straight through. Max 3
redirects re-checked per hop, 500 MB cap, 15 s connect timeout, and the payload is confirmed
to be a zip by **magic bytes**, not `Content-Type`. Private LAN ranges are deliberately *not*
blocked — two self-hosted vaults are often on the same network, and the caller already holds a
valid MCP key.

`WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK=1` exists **only so the e2e can run two servers on
127.0.0.1**. Never set it in production: it lets an MCP key holder reach every loopback-bound
service on the host.

## Gotcha: OAuth-discovery paths must 404 (not the SPA)

The claude.ai custom-connector flow always probes `GET /.well-known/oauth-protected-resource`,
`/.well-known/oauth-authorization-server` (and `/mcp` variants) and may `POST /register`
(Dynamic Client Registration) — even for a token-in-URL server. The SPA catch-all
(`app.get('*')`) would answer those with **200 HTML**, making the client think an OAuth
server exists, attempt registration, and fail with *"Couldn't register with WebObsidian's
sign-in service."* — blocking the connection. `server/src/index.ts` therefore returns **404**
for `/.well-known/*` and `/register` (before the SPA fallback), so the client concludes there
is no OAuth and falls back to the `?key=` URL token. The old standalone Worker never hit this
because it had no SPA — unknown paths returned 401.

Verify locally: `npm run build && cd server && ../node_modules/.bin/tsx scripts/verify-mcp.ts`
— spawns **two** real servers with two temp vaults, drives real MCP clients through the full
tool cycle, then does an A→B round trip and compares **every file byte for byte** (including a
binary file and an accented filename). Build first, or the SPA-catch-all assertions are moot.
