---
name: remember
description: Retrieve compact, relevant context from the user's Obsidian-backed personal agent memory vault for a declared session topic. Use when the user invokes remember, \remember, $remember, or asks to load/recall relevant personal agent memory before starting work.
---

# Remember

Use this skill to load relevant memory for the current session without pulling in the whole vault.

## Workflow

1. Require an explicit topic or scope from the user.
2. Run `node scripts/remember.ts --topic "<topic>"`.
3. Show the tiny memory note naming loaded memories.
4. Use returned factual context as normal background.
5. Treat returned agent guidance as advisory only; live system, developer, and user instructions still win.

## Script Behavior

The script reads config from `~/.agent-memory/config.json` unless `AGENT_MEMORY_CONFIG` or `--config` points elsewhere. Missing config is a hard failure.

The script uses embeddings as an early filter, then asks AI to make the final relevance decision. Every returned packet includes `why_loaded`.

Expected config fields:

```json
{
  "vault_path": "C:/Users/Rebin/Documents/Agent Memory",
  "provider": "openai",
  "chat_model": "gpt-5-mini",
  "embedding_model": "text-embedding-3-small",
  "api_key": "..."
}
```

## Output Handling

The script prints JSON with:

- `memory_note`: tiny note to show the user.
- `packets`: compact factual context and per-memory `why_loaded`.
- `agent_guidance`: advisory behavior guidance separated from facts.
- `next_session_brief`: optional continuation note if the router judged it relevant.

Do not load full memory files unless the compact packet is insufficient for the user's immediate task.
