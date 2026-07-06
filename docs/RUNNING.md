# Running WebObsidian — cold-start runbook

Assume zero prior context. This covers: running the dev stack, running
production (bare-metal or Docker), the git remote topology (fork vs.
upstream), and known gotchas hit while verifying changes.

## Repo / remote topology

This checkout (`/Users/henry/Documents/Projects/webobsidian`) has two remotes:

- `origin` → `https://github.com/xnohat/webobsidian.git` — the **upstream**
  repo this project was based on. Treat as **read-only reference** (pulling
  upstream fixes), not a push target unless the user explicitly says so.
- `fork` → `https://github.com/blueberry6401/webobsidian.git` — the user's
  **own repo**. This is where local fixes get pushed (`git push fork
  HEAD:main` or, once `main` is checked out here, `git push fork main`).

`gh` is authenticated on this machine as `blueberry6401` (`gh auth status`
confirms). `gh auth setup-git` has already been run once, which makes `git
push`/`pull` over `https://github.com` use gh's stored token automatically —
if a fresh clone/environment hits `fatal: could not read Username for
'https://github.com'`, that's the fix (re-run `gh auth setup-git`, or `gh
auth login` first if `gh auth status` shows logged out).

`local main` here is currently fast-forwarded to match `fork/main` (commit
`db34858` — "fix: make bare URLs in Live Preview open on click"). `origin/main`
is one commit behind (`c41967a`) — that gap is expected; it has **not** been
pushed upstream, only to the fork.

## Dev stack (hot-reload)

From the repo root:

```bash
npm install        # first time / after pulling deps changes (root + workspaces)
npm run dev         # starts server (8787) + web (5173) together
```

- Web dev server (Vite): **http://localhost:5173**
- API server (Express): **http://localhost:8787**
- Vault used in dev: `server/sample-vault` (bundled, gitignored contents
  aside from placeholder files). Runtime config: `server/data/settings.json`
  (gitignored — created on first boot).
- **Login**: first load shows an unlock screen. Default password is
  `123456` (see `server/src/services/auth.ts`, `DEFAULT_PASSWORD`). Logging
  in with it immediately forces a "Set a new password" screen — you cannot
  stay on the default. This is intentional (`hasCustomPassword()` gate), not
  a bug.
- Stop: `pkill -f "tsx watch src/index.ts"` and `pkill -f vite` (or kill the
  `npm run dev` process group / its PID if you captured it).

To verify the stack is actually up (don't just assume):

```bash
curl -sf http://localhost:5173 >/dev/null && echo "web up"
curl -sf http://localhost:8787/healthz && echo   # or any /auth/* route — expect JSON, not a connection error
```

Note: this machine's `bash`/`zsh` has **no GNU `timeout` command** (no
coreutils installed) — don't script `timeout 30 ...` waits; poll manually,
e.g.:

```bash
for i in $(seq 1 20); do curl -sf http://localhost:5173 >/dev/null && break; sleep 1; done
```

## Production (bare-metal)

```bash
npm run build   # builds web, then server
npm run start   # server serves the built web app, production mode
```

Reads `PORT`, `HOST`, `VAULT_PATH`, `DATA_DIR`, `ALLOWED_ROOTS`, `NODE_ENV`
env vars (see commented "Bare-metal only" block in `.env.example`).

## Production (Docker)

```bash
cp .env.example .env   # edit VAULT_HOST_PATH to point at your real vault
docker compose up -d --build
```

- Publishes on `${HTTP_PORT:-8787}` (host) → `8787` (container).
- `VAULT_HOST_PATH` (default `./sample-vault`) is bind-mounted to `/vault`.
- `webobsidian-data` named volume persists `settings.json` + search index
  across container recreation.
- Set `WEBOBSIDIAN_PASSWORD` in `.env` to skip the first-run unlock UI.
- Healthcheck hits `GET /healthz`.

## Planned: standalone deployment checkout at `../_deployment`

Decision (this session): dev work happens in **ephemeral, harness-managed
git worktrees** under `.claude/worktrees/<session-id>/` — those branches are
deleted when a session closes. For an actual long-running / production
instance, use a **plain, non-worktree clone** of the fork, kept at
`/Users/henry/Documents/Projects/_deployment` (a sibling of this
`webobsidian/` directory — NOT nested inside `.claude/worktrees/`).

That directory does not exist yet. See the companion kickoff prompt
(handed to the user in the same turn this file was written) for the
concrete migration steps — clone `fork`, point its own `origin` at the fork
(not upstream), keep upstream reachable as a second remote for pulling
future updates, install deps, and get `npm run build && npm run start` (or
`docker compose up`) verified green there before treating it as the real
deployment.

## Known gotchas hit this session

- **Playwright/Chromium not preinstalled.** `npx playwright install
  chromium --with-deps` was needed before any browser-driven test could run
  (no `chromium-cli` binary on this machine either — used the raw
  `playwright` npm package directly).
- **`gh` wasn't authenticated initially** — `git push` to the fork failed
  with `Permission denied (publickey)` over SSH and `could not read
  Username` over HTTPS until `gh auth login` (user did this interactively)
  + `gh auth setup-git` were done.
- **Live Preview's bare-URL click bug** (just fixed): a plain
  `https://...` URL not wrapped in `[text](url)` got a cosmetic `cm-url`
  style mark but no click handler — see `web/src/lib/livePreview.ts`,
  `editorClickFix`. Fixed with a `mousedown` handler that scheme-validates
  (`http:`/`https:`/`ftp:` only) before `window.open`.
