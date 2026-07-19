---
name: organize
description: Save durable memory from the current Codex conversation into the user's Obsidian-backed personal agent memory vault. Use when the user invokes organize, \organize, $organize, or asks to save/organize/record lasting session memory at the end of a chat or work session.
---

# Organize

Use this skill to turn the current session into durable Obsidian memory.

## Workflow

1. Build a best-effort session record from the visible conversation and your activity.
2. Save that record as a temporary JSON file.
3. Run `node scripts/organize.ts --session <session-record.json>`.
4. Report the short human summary from the script.
5. Keep the structured agent report in mind as advisory context if the session continues.

Use `--dry-run` only when the user explicitly asks to preview or test without writing.

## Session Record

Create JSON with this shape:

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
    "organized_at": "ISO-8601 timestamp",
    "trigger": "manual_skill_invocation",
    "transcript_source": "agent_produced"
  }
}
```

The transcript is agent-produced and best-effort. Prefer a compact but specific narrative over a noisy dump. Include important exact wording only when it shaped a decision.

## Script Behavior

The script reads config from `config/config.json` in the project root unless `AGENT_MEMORY_CONFIG` or `--config` points elsewhere. `AGENT_MEMORY_VAULT` must point to the vault directory. Missing config or vault environment variable is a hard failure.

The script owns AI routing, AI extraction, safe vault writes, source note creation, metadata validation, and index updates. Do not manually edit the vault to imitate the script unless debugging the script itself.

Expected config fields:

```json
{
  "provider": "openai",
  "chat_model": "gpt-5-mini",
  "embedding_model": "text-embedding-3-small",
  "api_key": "..."
}
```

## Reporting

Show the user the script's short report. If the script prints an error, explain the setup or validation issue and stop.
