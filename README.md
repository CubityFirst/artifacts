<img src="assets/icon.svg" width="64" height="64" alt="">

# Artifacts

A self-hosted home for AI-made artifacts: web pages, documents, images, video, audio, PDFs, data and code. Any MCP-capable assistant (Claude Code, Codex, Gemini CLI, Cursor, VS Code, …) can publish here, and a dashboard lets you browse, preview, version, share, password-protect and delete everything in one place.

Runs as one Cloudflare Worker: D1 holds the metadata, R2 holds the file bytes.

## How it fits together

| Origin | Serves |
| --- | --- |
| `APP_ORIGIN` (`artifacts.cubityfir.st`, dev `http://localhost:5180`) | Dashboard SPA, `/api/*`, `/auth/*` (OIDC), `/mcp` |
| `CONTENT_ORIGIN` (`artifacts-content.cubityfir.st`, dev `http://127.0.0.1:5180`) | The artifacts themselves |

Artifacts are untrusted HTML/JS, so they live on a separate origin that never sets cookies. Access works like this:

- **Private:** only the owner can open it, through short-lived signed preview URLs (`/t/<token>/…`) that the dashboard issues.
- **Anyone with link:** `/<slug>/…` is public. The slug is a random 12-character string.
- **Link + password:** the visitor enters the password, then gets a 12-hour signed `/t/<token>/` link.
- **Revoking access:** regenerating the link, or changing visibility or the password, bumps a share epoch. That invalidates every outstanding token. An optional expiry turns off public access after a set time.

Every change creates a new version. Files are content-addressed per artifact in R2, so versions share unchanged files. Markdown, code and data get rendered viewers, media gets players, and video/audio support HTTP range requests.

Deleting (from the dashboard or MCP) moves an artifact to **Trash**. Its links stop working at once, and it's hidden everywhere else. From Trash you can restore it, which brings it back private, or delete it forever. The hourly cron deletes anything that has been in trash for 30 days.

## Sign-in: cubityfir.st (OIDC)

- Authorization Code + PKCE (S256) with `state` and `nonce`, using [`openid-client`](https://github.com/panva/openid-client) configured from the discovery document.
- id_tokens are verified for RS256 signature (JWKS), `iss`, `aud`, `exp` and `nonce` (`enableNonRepudiationChecks`).
- Users are keyed on `sub`. Sessions are our own (7 days) and don't depend on the provider's token lifetime.
- Admin pages are gated on `roles.includes("admin")`.
- Sign-out deletes the session, then redirects to the provider's `end_session_endpoint` with `id_token_hint`.
- Server-side OIDC calls go through the `OIDC` service binding to `cubityfirst-auth`. In local dev (`OIDC_TRANSPORT=public`) they use the public issuer instead.
- An hourly cron deletes local data for identities that `IdentityService.listDeletedUsers` reports.
- The registered client's redirect URIs live in [`oidc-client.json`](oidc-client.json). After editing them, run `npm run oidc update`; `npm run oidc show` prints the current registration.

## MCP tools

`publish_artifact`, `update_artifact`, `edit_artifact_file`, `get_artifact`, `list_artifacts`, `set_artifact_sharing`, `delete_artifact`.

Authenticate with a per-user access token created on the dashboard's **Connect & settings** page (`Authorization: Bearer art_…`). That page also has copy-paste setup for each client.

## Uploading local files

MCP tool calls carry file contents as text the model has to write out, which is slow and costly for anything big or binary. For files already on disk, upload them directly with the same token:

```sh
node bin/artifacts.mjs login < token.txt          # or set ARTIFACTS_TOKEN; stored in Windows Credential Manager
node bin/artifacts.mjs upload ./site -t "Benchmarks" --link    # prints the link
node bin/artifacts.mjs upload chart.png=img/chart.png --to <id> -m "New chart"   # new version
node bin/artifacts.mjs help
```

The CLI has no dependencies (Node 22+). Folders keep their relative paths; dotfiles and `node_modules` are skipped.

The endpoints are plain multipart/form-data, so `curl` works too. Each `file` part's filename is its path in the artifact:

| Endpoint | Fields |
| --- | --- |
| `POST /v1/artifacts` | `file` (repeatable), `title`, `description`, `entry`, `visibility`, `password`, `model`, `message` |
| `POST /v1/artifacts/:id` | `file`, `delete` (repeatable), `replace_all`, `title`, `description`, `entry`, `model`, `message` |
| `GET /v1/me` | Checks a token |

One request can be at most 100 MB (Cloudflare's request limit on Free/Pro plans); the per-file and per-artifact limits match MCP's (50 MB / 200 MB).

## Local development

```sh
npm install
npm run dev                # http://localhost:5180 (dashboard), http://127.0.0.1:5180 (content)
npm run typecheck
ARTIFACTS_TOKEN=art_… node scripts/mcp-smoke.mjs   # end-to-end MCP + content checks
```

`.dev.vars` (gitignored) holds `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SESSION_SECRET`, and the client's `OIDC_REGISTRATION_ACCESS_TOKEN` / `OIDC_REGISTRATION_CLIENT_URI`. The registration token is the only way to change the OIDC client, so back it up somewhere safe.

The D1 schema is applied automatically by the Worker on first request (`src/server/db.ts`).

## Deploying

1. Set the Worker secrets (prompts for each value; copy them from `.dev.vars`):
   `npx cf workers secrets update` for `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SESSION_SECRET`.
2. Run `npm run deploy`. This provisions D1/R2 and attaches the custom domains from `cloudflare.config.ts`.
