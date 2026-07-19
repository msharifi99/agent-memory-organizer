# Personal Agent Memory System

Obsidian-backed memory tools for Codex sessions.

This project provides two Codex skills and an additive remote MCP service:

- `$organize`: saves durable memory from the current session into an Obsidian vault.
- `$remember`: retrieves compact, relevant memory for a declared topic at the start of a session.
- Remote MCP: exposes the same engine through authenticated tools and curated resources.

The Obsidian vault is the canonical store. Memory files are plain Markdown with adjacent JSON metadata, so they can be inspected, edited, backed up, and rebuilt.

## Requirements

- Node.js 24 or newer.
- An OpenAI API key.
- A configured memory vault path.

Node 24 can run the TypeScript files directly, so there is no build step.

## Configuration

Create this project-local file:

```text
config/config.json
```

Example:

```json
{
  "provider": "openai",
  "chat_model": "gpt-5-mini",
  "embedding_model": "text-embedding-3-small",
  "api_key": "YOUR_OPENAI_API_KEY",
  "cloudflare_access_team_domain": "your-team.cloudflareaccess.com",
  "cloudflare_access_audience": "YOUR_ACCESS_APPLICATION_AUD"
}
```

Set the vault path separately in the environment:

```bash
export AGENT_MEMORY_VAULT=./vault
```

The tool will create the vault root if its parent folder exists. It will also create these system entries inside the vault:

- `inbox`
- `sources`
- `archive`
- `reports`
- `.index`
- `activity-log.md`

Relative `AGENT_MEMORY_VAULT` values are resolved from the project root, so `./vault` stores data in `vault/` beside this README.

To use a different config file for testing, pass `--config <path>` or set `AGENT_MEMORY_CONFIG`. `AGENT_MEMORY_VAULT` is required whether the default or an alternate config file is used.

## Run Tests

From the project root:

```bash
node --test tests/*.test.ts
```

The tests use stubbed AI responses and do not call the OpenAI API.

## Organize Memory

The normal way to use this is to invoke `$organize` in Codex at the end of a session. The skill asks the current agent to produce a session record, then the TypeScript tool routes, extracts, and writes memory.

Manual dry-run example:

```bash
node .\skills\organize\scripts\organize.ts --session .\session.json --dry-run
```

Real write:

```bash
node .\skills\organize\scripts\organize.ts --session .\session.json
```

Session JSON shape:

```json
{
  "transcript": "Best-effort visible transcript or compact session narrative.",
  "activity_appendix": {
    "files_read": [],
    "files_changed": [],
    "artifacts_created": [],
    "commands_or_tools_used": [],
    "tests_or_verifications": [],
    "notable_errors_or_blockers": []
  },
  "session_metadata": {
    "organized_at": "2026-06-21T00:00:00+02:00",
    "trigger": "manual_skill_invocation",
    "transcript_source": "agent_produced"
  }
}
```

## Remember Context

Invoke `$remember` with an explicit topic at the start of a session.

Manual example:

```bash
node .\skills\remember\scripts\remember.ts --topic "personal agent memory system"
```

The output includes:

- `memory_note`: a tiny note naming loaded memories.
- `packets`: compact factual context with `why_loaded`.
- `agent_guidance`: advisory guidance separated from factual context.
- `next_session_brief`: optional continuation context when relevant.

## Rebuild Indexes

Indexes are derived from canonical Markdown and metadata files. Rebuild them with:

```bash
node .\src\memory-system\cli.ts rebuild-index
```

## Remote MCP Service

The service exposes stateless Streamable HTTP at `/mcp`, plus minimal origin-only probes at `/healthz` and `/readyz`. Its six tools are `remember`, `organize`, `rebuild_index`, `init_vault`, `list_memories`, and `get_memory`. Curated memory resources use stable `memory://memories/<slug>` URIs.

For the complete dashboard, deployment, verification, and ChatGPT connection procedure, see [Cloudflare Managed OAuth setup](docs/cloudflare-oauth-setup.md).

[Cloudflare Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) owns OAuth discovery, dynamic client registration, authorization-code, PKCE, and the single-user allow policy at the public edge. The origin independently verifies the `Cf-Access-Jwt-Assertion` signature, team issuer, expiry, and application audience on every `/mcp` request. Origin health probes are unauthenticated; configure the same Access policy over all public hostname paths, including the probes.

Copy `.env.example` to `.env` and create a deployment config based on `deploy/memory-config.example.json`. Set:

- `AGENT_MEMORY_VAULT` to the writable host vault directory (defaults to `./vault` in `.env.example`). Compose mounts it at `/data/vault` and sets the container's `AGENT_MEMORY_VAULT` to that path.
- `MEMORY_CONFIG_DIR` to the read-only configuration directory (defaults to `./config` in `.env.example`). The container reads `config.json` from that mounted directory.
- `cloudflare_access_team_domain` and `cloudflare_access_audience` in `config/config.json` to the Access team domain and application's AUD tag.

The container's `node` user uses UID/GID 1000 in the Alpine image. Ensure the host vault bind mount is writable by that identity.

Build and start the one supported replica:

```bash
docker compose up -d --build
```

Do not publish port 3000 on the host. Configure your public ingress to reach the service using your deployment's normal networking; this Compose file has no Cloudflare Tunnel network dependency. The Compose service runs as a non-root user, mounts the vault read-write and config read-only, waits for transaction recovery before readiness, allows active requests to drain during shutdown, and rotates JSON logs.

The service writes structured JSON logs for startup and shutdown, every HTTP request, MCP tool calls, and resource listing or reads. HTTP and MCP request IDs correlate protocol activity with its transport request; timing fields expose queue, model, and total latency. Tool failures include scrubbed error names and messages. Authorization headers are never logged, and secret-like values in logged inputs, outputs, errors, paths, and user agents are redacted.

### Manual Cloudflare and ChatGPT checklist

1. Create or update the Cloudflare Access application for the public MCP hostname, enable Managed OAuth and dynamic client registration, and allow the MCP client's HTTPS redirect URI.
2. Restrict its policy to the vault owner's identity and apply it to every hostname path.
3. Put the application's AUD tag and team domain in `config/config.json`.
4. Route the public hostname through your existing ingress configuration.
5. Confirm public HTTPS access performs the Access OAuth flow and direct origin requests without a valid Access assertion receive HTTP 401.
6. In ChatGPT developer mode, connect the public `https://<hostname>/mcp` URL, complete OAuth, inspect all six tool annotations, and exercise representative read and write calls.

The current personal deployment uses `https://memory.gptify.pro/mcp`. Cloudflare advertises its protected-resource document in the unauthenticated `WWW-Authenticate` challenge and publishes authorization-server metadata at `/.well-known/oauth-authorization-server`. ChatGPT callbacks are restricted to `https://chatgpt.com/connector/oauth/*`; localhost and loopback registration are disabled.

OpenAI domain verification is served independently by an exact-route Cloudflare Worker, so it remains available while the development MCP origin and Tunnel are stopped. Only `/.well-known/openai-apps-challenge` bypasses Access.

## Project Layout

```text
src/memory-system/          TypeScript memory engine
src/mcp/                    Authenticated Streamable HTTP MCP service
skills/organize/            Codex organize skill
skills/remember/            Codex remember skill
tests/                      Node test suite with stubbed AI
.scratch/                   Local PRDs and planning docs
```

## Safety Notes

- Missing config is a hard failure.
- Raw secret-like values are scrubbed from normal memory output.
- Source notes are compressed, not full raw transcript archives.
- Retrieval guidance is advisory and does not override live instructions.
- Low-confidence new memories are routed to `inbox/`.
- MCP mutations are serialized and protected by recoverable same-filesystem transactions.
- The origin trusts only validated Cloudflare Access assertions for `/mcp`.
