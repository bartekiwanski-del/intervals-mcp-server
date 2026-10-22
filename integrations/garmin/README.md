# Garmin Bartek

Private, read-only Garmin Personal API connection for ChatGPT. This is a separate
Node service; it does not change the Intervals Python server.

## Render configuration

- Branch: `garmin-bartek`
- Build command: `npm --prefix integrations/garmin ci --ignore-scripts --no-audit --no-fund`
- Start command: `node integrations/garmin/server.mjs`
- Runtime: Node 24; one instance
- Region: Frankfurt
- Initial compute plan: Free (may sleep when idle)
- `/healthz` checks the process; `/readyz` checks configuration.

Environment variables are managed in the Render Dashboard, not in a Blueprint.

| Variable | How to set it |
|---|---|
| `GARMIN_PERSONAL_API_KEY` | Paste the personal Garmin key directly into Render. |
| `MCP_LOGIN_PASSWORD` | Choose a unique password, 16–256 characters, for this connection. This is not your Garmin password. |
| `MCP_SIGNING_KEY` | Deployment-generated cryptographically random secret; keep it stable across deploys. |
| `PUBLIC_URL` | Optional HTTPS origin; Render's documented `RENDER_EXTERNAL_URL` is the default. |

The server stays closed until all three secrets are valid. Use **Save and deploy**
after entering the Garmin key and login password. Do not paste secrets into chat,
commit them, or put them in URLs.

## Connect ChatGPT

In ChatGPT web, open Plugins → Add custom MCP server. Use the deployed URL with
`/mcp`, choose OAuth, and leave client ID and client secret empty. The server
supports dynamic client registration (DCR), authorization-code flow with S256
PKCE, and confidential client authentication. If a registration choice appears,
choose DCR. Sign in with `MCP_LOGIN_PASSWORD`, then install the personal plugin.

Only the stable ChatGPT callback and callback-ID-specific ChatGPT URLs are allowed.
Authorization responses include the exact issuer (`iss`).

After linking, check the last seven days of Body Battery, sleep, HRV, stress and
heart rate against Garmin Connect. Verify mobile availability separately on the
same account. No live Garmin verification is possible before the user enters the key.

## Authentication and operation

- All MCP requests require an OAuth access token. Public pages contain no health data.
- Access tokens last one hour. Refresh tokens last 30 days and require the
  confidential client's secret; public (`none`) OAuth clients are rejected.
- Registrations and signed tokens survive restarts without a database. In-flight
  login transactions and one-time authorization codes are stored only in memory,
  so a restart during login requires starting that login again.
- Refresh tokens are not single-use: they are restricted to authenticated
  confidential clients. Replacing `MCP_LOGIN_PASSWORD` invalidates existing
  access/refresh tokens. Replacing `MCP_SIGNING_KEY` also invalidates registrations.
- Use one instance because pending authorization codes are process-local.
- Login attempts, client registrations and requests are rate-limited. Login forms
  require a Secure/HttpOnly cookie and matching browser origin.
- Garmin Personal API data is requested on demand; there are no webhook subscriptions.
- Credentials and provider exception details are never logged by this gateway.
- Upstream dependency is pinned to `garmin-personal-mcp@0.1.1`; dependency versions
  are locked by `package-lock.json`. Review updates before deploying them.

## Verification

Run `npm ci --ignore-scripts`, `npm run check`, and `npm test` in this directory.
Tests exercise actual JWT signing/verification, PKCE, one-time codes, callback
validation, password/CSRF checks, token expiry, refresh after restart, credential
rotation, closed configuration and the real upstream 25-tool MCP catalog. All
tests use synthetic credentials; none contacts Garmin.

Repository-wide Python verification is governed by the root `AGENTS.md`.
