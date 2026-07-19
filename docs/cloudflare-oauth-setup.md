# Cloudflare Managed OAuth setup for the Remote Memory MCP server

This guide configures Cloudflare Access as the OAuth 2.0 authorization server for this project's remote MCP endpoint. It is written for a personal deployment where one owner connects the server to ChatGPT.

The final request path is:

```text
ChatGPT
  -> Cloudflare Managed OAuth and owner-only Access policy
  -> Cloudflare Tunnel
  -> memory-mcp:3000/mcp
  -> validation of the Cf-Access-Jwt-Assertion JWT
```

Cloudflare handles OAuth discovery, dynamic client registration, authorization code flow, PKCE, and user login. After authentication, Cloudflare injects a signed `Cf-Access-Jwt-Assertion` header into the origin request. This server verifies that JWT's signature, issuer, expiry, and application audience before it accepts an MCP request.

Do not add a second OAuth implementation to the MCP server. Cloudflare Managed OAuth is the OAuth layer; JWT validation at the origin is the server's independent authorization check.

## Before you begin

You need:

- A domain managed by Cloudflare.
- A Cloudflare Zero Trust organization with an identity provider configured. One-time PIN login is sufficient for a simple personal setup, although an external identity provider with MFA is preferable.
- The Remote Memory MCP service deployed from this repository.
- The exact email address that should be allowed to use the server.

Choose these values before starting:

| Value | Example | Purpose |
| --- | --- | --- |
| Public hostname | `memory.example.com` | Public hostname routed through Access and the tunnel |
| MCP URL | `https://memory.example.com/mcp` | URL entered in Cloudflare and ChatGPT |
| Team domain | `your-team.cloudflareaccess.com` | Expected JWT issuer and JWKS host |
| Owner email | `you@example.com` | The only identity allowed by the Access policy |

## 1. Prepare the MCP service

Copy the environment template and deployment config:

```bash
cp .env.example .env
mkdir -p config
cp deploy/memory-config.example.json config/config.json
```

Edit the copied config to include the Cloudflare Access values:

```json
{
  "cloudflare_access_team_domain": "your-team.cloudflareaccess.com",
  "cloudflare_access_audience": "replace-with-access-application-aud"
}
```

Then set the mount paths in `.env`:

```dotenv
AGENT_MEMORY_VAULT=./vault
MEMORY_CONFIG_DIR=./config
```

Compose uses `AGENT_MEMORY_VAULT` as the host bind-mount source and sets its value inside the container to `/data/vault`.

Make sure the vault directory exists and is writable by UID/GID 1000, which is the container's `node` user. Do not publish container port 3000 on the host.

## 2. Route the hostname through your ingress

Configure the public hostname to reach this deployment using your existing ingress arrangement. This Compose file does not join or require a Cloudflare Tunnel Docker network.

In the Cloudflare Zero Trust dashboard:

1. Open **Networks > Tunnels**.
2. Attach the configured public hostname, such as `memory.example.com`, to the deployment origin.
3. Save the hostname route.


At this stage a request might reach the origin without authentication. Finish the Access configuration before treating the deployment as public.

## 3. Register the MCP server with Cloudflare Access

In the Zero Trust dashboard:

1. Open **Access controls > AI controls > MCP servers**.
2. Select **Add an MCP server**.
3. Give it a recognizable name, such as `Personal Agent Memory`.
4. Enter the full MCP URL, including the path: `https://memory.example.com/mcp`.
5. Continue to the Access policy configuration.

Cloudflare may also show the resulting application under **Access controls > Applications**. That application is where its audience tag and Managed OAuth settings are maintained.

See Cloudflare's current [Secure MCP servers guide](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/) if the dashboard labels have changed.

## 4. Create an owner-only Access policy

Create an **Allow** policy for the MCP application:

1. Under **Include**, choose **Emails**.
2. Enter the owner's exact email address.
3. Optionally add a **Require** rule for the desired identity provider or authentication method.
4. Save the policy and application.

Avoid an `Everyone` rule and avoid allowing an entire email domain for a personal vault. Apply Access to the whole hostname, not only `/mcp`; the public `/healthz` and `/readyz` paths should also be protected at Cloudflare even though they are intentionally unauthenticated inside the private Docker network.

Cloudflare evaluates Access policies at the edge. The origin's JWT audience check then ensures that a valid token issued for some other Access application cannot be used with this MCP server. Refer to the [Access policy documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/) for more complex identity rules.

## 5. Enable Managed OAuth

In the Zero Trust dashboard:

1. Open **Access controls > Applications**.
2. Find the MCP server application, open its menu, and select **Edit**.
3. Open **Advanced settings**.
4. Turn on **Managed OAuth**.
5. Enable dynamic client registration for the MCP client.
6. Save the application.

Recommended settings for a personal agent are:

- Access token lifetime: 5–15 minutes.
- Grant/session lifetime: 1–2 weeks, depending on how often you want to log in again.
- Localhost or loopback redirects: off unless you are testing a local CLI client that needs them.
- Redirect URI restrictions: HTTPS only in production.

For ChatGPT, allow the production callback shown in the app management page. Current callbacks use `https://chatgpt.com/connector/oauth/{callback_id}`. You may allow the exact URI after the first connection attempt, or use Cloudflare's path-scoped `https://chatgpt.com/connector/oauth/*` pattern when dynamic app instances must register before their callback ID is known. Do not wildcard the hostname. Keep `https://chatgpt.com/connector_platform_oauth_redirect` only when an existing legacy app still needs it.

Cloudflare documents the complete behavior and current controls in [Managed OAuth for Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/). In the OAuth flow, unauthenticated non-browser requests receive a `401` response and a `WWW-Authenticate` challenge, while interactive authorization opens the Cloudflare Access login page.

## 6. Configure JWT validation at the origin

Find the application's audience value:

1. Open **Access controls > Applications**.
2. Edit the MCP application.
3. Open **Additional settings**.
4. Copy the **Application Audience (AUD) Tag**.

Find your team domain in the Zero Trust organization settings. It has the form `your-team.cloudflareaccess.com`; use the hostname only, without `https://` or a trailing slash.

Set both values in `config/config.json` as `cloudflare_access_team_domain` and `cloudflare_access_audience`.

Then build and start the service:

```bash
docker compose up -d --build
docker compose ps
```

The server fetches signing keys from:

```text
https://your-team.cloudflareaccess.com/cdn-cgi/access/certs
```

It accepts `/mcp` requests only when the assertion is signed by Cloudflare for the configured team domain and contains the configured audience. Cloudflare's [JWT validation guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) describes these claims and keys.

If the Access application is deleted and recreated, copy its new AUD tag into `config/config.json` and restart the service. Editing the existing application normally preserves the audience.

## 7. Verify Cloudflare and the origin

First verify private container readiness:

```bash
docker compose exec memory-mcp node -e \
  "fetch('http://127.0.0.1:3000/readyz').then(async r => { console.log(r.status, await r.text()); if (!r.ok) process.exit(1) })"
```

Expected output includes HTTP `200` and `{"status":"ready"}`.

Next test the public MCP URL without credentials:

```bash
curl -i https://memory.example.com/mcp
```

For a non-browser client, expect Cloudflare to return HTTP `401` with a `WWW-Authenticate` header containing OAuth discovery information. Read the `resource_metadata` URL from that challenge and inspect it directly. Cloudflare currently advertises an MCP-path-specific endpoint:

```bash
curl -sS https://memory.example.com/.well-known/cloudflare-access-protected-resource/mcp
curl -sS https://memory.example.com/.well-known/oauth-authorization-server
```

Do not consider a browser login page by itself sufficient verification. The important checks are that unauthenticated MCP requests receive Cloudflare's OAuth challenge, successful login is limited to the owner, and the origin rejects requests that lack a valid `Cf-Access-Jwt-Assertion`.

## 8. Connect the server to ChatGPT

The labels can evolve, so consult OpenAI's current [Connect your MCP server to ChatGPT guide](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt#create-a-developer-mode-app) if the UI differs.

1. In ChatGPT, open **Settings > Security and login** and enable **Developer mode**.
2. Open **Settings > Plugins**, or visit `https://chatgpt.com/plugins`.
3. Select the add (`+`) button and create a developer-mode app.
4. Enter a name and description.
5. Set the MCP server URL to `https://memory.example.com/mcp`.
6. Create the app and complete the Cloudflare Access login using the allowed owner identity.
7. Confirm that ChatGPT discovers the server's tools.

The expected tools are:

- `remember`
- `organize`
- `rebuild_index`
- `init_vault`
- `list_memories`
- `get_memory`

Start with read-only calls such as listing or retrieving memories. Then test `organize` only with a session record that the user intends to persist.

## 9. Verify the app domain

OpenAI verifies ownership by reading an exact token from:

```text
https://memory.gptify.pro/.well-known/openai-apps-challenge
```

The current deployment serves this path from the `agent-memory-openai-domain-verification` Cloudflare Worker. Its `CHALLENGE_TOKEN` is a secret-text binding, and its Worker route matches only the exact challenge path. A separate Access application named `OpenAI domain verification challenge` applies a Bypass policy only to that exact path. The more general MCP Access application continues to protect every other path.

The Worker source is in `deploy/openai-domain-verification-worker.js`. After rotating a verification token, update the Worker's secret binding and verify the response before selecting **Verify Domain**:

```bash
curl -i https://memory.gptify.pro/.well-known/openai-apps-challenge
```

Expect HTTP `200`, `Content-Type: text/plain`, and the exact token with no extra whitespace. Also confirm that `/mcp` and `/healthz` still return OAuth `401` responses without credentials.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Public `/mcp` does not return an OAuth challenge | Managed OAuth is not enabled on the application, the hostname is attached to a different Access application, or only some paths are protected. |
| `invalid_redirect_uri` during ChatGPT connection | Add the exact HTTPS redirect URI supplied by ChatGPT, or the path-scoped `https://chatgpt.com/connector/oauth/*` pattern, then retry. Never wildcard the hostname. |
| Login succeeds but `/mcp` returns `401` | Check the team domain and AUD tag in `config/config.json`, restart the container, and inspect `docker compose logs memory-mcp`. Also ensure no proxy between Cloudflare and the service removes `Cf-Access-Jwt-Assertion`. |
| JWT audience errors begin after recreating the app | The new Access application has a new AUD tag. Update `cloudflare_access_audience` in `config/config.json` and restart. |
| ChatGPT connects but shows no tools | Confirm the URL includes `/mcp`, uses public HTTPS, and that the Access application is configured as an MCP server with Managed OAuth. |
| Owner is repeatedly asked to authenticate | Increase the OAuth grant/session lifetime while keeping the access token short-lived. Check the Zero Trust session-duration settings too. |
| Someone other than the owner can log in | Remove broad `Everyone`, email-domain, or group rules and retain only the exact owner identity. Review all policies attached to the application. |

## Security checklist

- The Access policy allows only the intended owner identity.
- Managed OAuth and dynamic client registration are enabled on the MCP application.
- Redirects are HTTPS and no broader than needed.
- The full hostname, including health paths, is covered by Access.
- Port 3000 is not published on the host or firewall.
- `cloudflare_access_team_domain` and `cloudflare_access_audience` in `config/config.json` match the active application.
- The vault mount is writable only where required, and the config mount is read-only.
- Secrets are supplied through deployment secrets or `.env`, and `.env` is not committed.
- Read-only tools are tested before mutation tools; `organize` is tested only with data intended for persistence.

To revoke access quickly, disable the application policy or Managed OAuth in Cloudflare and remove the developer-mode app from ChatGPT. Avoid deleting and recreating the Access application unless you are prepared to update its audience value at the origin.
