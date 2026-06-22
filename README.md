# Personal Agent Memory System

Obsidian-backed memory tools for Codex sessions.

This project provides two Codex skills:

- `$organize`: saves durable memory from the current session into an Obsidian vault.
- `$remember`: retrieves compact, relevant memory for a declared topic at the start of a session.

The Obsidian vault is the canonical store. Memory files are plain Markdown with adjacent JSON metadata, so they can be inspected, edited, backed up, and rebuilt.

## Requirements

- Node.js 24 or newer.
- An OpenAI API key.
- A configured memory vault path.

Node 24 can run the TypeScript files directly, so there is no build step.

## Configuration

Create this file:

```text
C:\Users\Rebin\.agent-memory\config.json
```

Example:

```json
{
  "vault_path": "C:/Users/Rebin/Documents/Agent Memory",
  "provider": "openai",
  "chat_model": "gpt-5-mini",
  "embedding_model": "text-embedding-3-small",
  "api_key": "YOUR_OPENAI_API_KEY"
}
```

The tool will create the vault root if its parent folder exists. It will also create these system entries inside the vault:

- `inbox`
- `sources`
- `archive`
- `reports`
- `.index`
- `activity-log.md`

To use a different config file for testing, pass `--config <path>` or set `AGENT_MEMORY_CONFIG`.

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

## Project Layout

```text
src/memory-system/          TypeScript memory engine
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
