# WebObsidian 🔮

A self-hosted, **Obsidian-compatible web app**. Point it at a folder of Markdown
files and edit your "second brain" from any browser — with full-text search,
GitHub sync (incl. Git LFS), an API for AI agents, and community-plugin support.

> Design: [PRD.md](PRD.md) · Progress: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)

## Features

- 📝 **Editor & preview** — CodeMirror 6, live/source/reading views, wikilinks
  `[[...]]`, embeds `![[...]]`, tags `#tag`, callouts, task lists, backlinks,
  outline and an interactive **graph view**.
- 🔍 **QMD search** — fast full-text + fielded search (`tag:`, `path:`, `title:`),
  fuzzy + prefix, incremental indexing, persisted to disk.
- 🔄 **GitHub sync** — native `git` pull/commit/push with **Git LFS** for large
  files, optional auto-sync.
- 🔐 **Login gate** — a single master password (scrypt-hashed) protects everything.
- 🧩 **Community plugins** — install Obsidian plugins from GitHub; loaded against
  an Obsidian-API compatibility shim.
- 🤖 **Agent API** — scoped API keys let AI agents read/write/search the vault via
  REST (`/api/v1`). See [docs/AGENT_API.md](docs/AGENT_API.md).
- 🗃️ **Pure-JSON config** — all settings live in `data/settings.json`. No database.
- 🐳 **Docker** — one command to run the whole stack.

## Quick start (Docker)

```bash
# 1. Put your vault somewhere and edit docker-compose.yml volume mapping
#    (defaults to ./sample-vault)
# 2. Optionally set an initial password
export WEBOBSIDIAN_PASSWORD="change-me"
docker compose up --build
# open http://localhost:8787
```

On first load you'll set the master password (if not provided via env).

## Local development

```bash
npm install
npm run dev          # server :8787 + web dev server :5173 (proxied)
# open http://localhost:5173
```

Production build (server serves the built SPA):

```bash
npm run build
VAULT_PATH=./sample-vault npm start
# open http://localhost:8787
```

## Configuration (env)

| Var | Default | Description |
|-----|---------|-------------|
| `PORT` | `8787` | HTTP port |
| `VAULT_PATH` | `./sample-vault` | Path to the notes vault |
| `DATA_DIR` | `./data` | Where `settings.json` + search index live |
| `ALLOWED_ROOTS` | – | Comma-separated roots the vault picker may browse |
| `WEBOBSIDIAN_PASSWORD` | – | Seed the master password on first run |

Everything else (git remote/token, API keys, plugins, theme) is configured in the
**Settings** UI and stored in `data/settings.json`.

## Architecture

See [PRD.md §2](PRD.md). Monorepo: `server/` (Express + TS API) and `web/`
(React + Vite SPA, built into `server/public`).

## License

MIT
