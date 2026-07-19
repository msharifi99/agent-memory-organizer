import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AIClient, JsonObject, JsonSchemaFormat } from "../src/memory-system/ai.ts";
import {
  ConfigError,
  DEFAULT_CONFIG_PATH,
  PROJECT_ROOT,
  loadConfig,
  memoryConfigFromObject,
} from "../src/memory-system/config.ts";
import type { MemoryConfig } from "../src/memory-system/config.ts";
import {
  createMemory,
  discoverMemories,
  ensureVault,
  loadMemory,
  rebuildIndexes,
  recoverVaultTransactions,
  runVaultTransaction,
} from "../src/memory-system/vault.ts";
import { EXTRACTOR_RESPONSE_SCHEMA, organizeSession, rememberTopic } from "../src/memory-system/workflows.ts";

class FakeAI implements AIClient {
  responses: JsonObject[];
  prompts: string[] = [];
  responseSchemas: (JsonSchemaFormat | undefined)[] = [];

  constructor(responses: JsonObject[] = []) {
    this.responses = [...responses];
  }

  embed(text: string): number[] {
    const total = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return Array.from({ length: 16 }, (_value, offset) => ((total + offset * 7) % 101) / 101);
  }

  chatJson(
    systemPrompt: string,
    _userPayload: JsonObject,
    responseSchema?: JsonSchemaFormat,
  ): JsonObject {
    this.prompts.push(systemPrompt);
    this.responseSchemas.push(responseSchema);
    const response = this.responses.shift();
    assert.ok(response, "Unexpected AI call");
    return response;
  }
}

class FailingNthEmbeddingAI extends FakeAI {
  private embeddingCalls = 0;
  private readonly failAt: number;

  constructor(responses: JsonObject[], failAt: number) {
    super(responses);
    this.failAt = failAt;
  }

  embed(text: string): number[] {
    this.embeddingCalls += 1;
    if (this.embeddingCalls === this.failAt) {
      throw new Error("Injected embedding failure.");
    }
    return super.embed(text);
  }
}

function withTempDir(callback: (tempDir: string) => void | Promise<void>): Promise<void> | void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-system-"));
  const result = callback(tempDir);
  if (result instanceof Promise) {
    return result.finally(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function configFor(vault: string): MemoryConfig {
  return {
    vaultPath: vault,
    provider: "openai",
    chatModel: "chat-test",
    embeddingModel: "embed-test",
    apiKey: "test-key",
    apiBase: "https://api.openai.com",
    maxEmbeddingCandidates: 12,
    maxRouterCandidates: 8,
  };
}

function sessionRecord(): JsonObject {
  return {
    transcript: "We decided the personal agent memory system uses Obsidian as canonical storage.",
    activity_appendix: {
      files_read: ["PRD.md"],
      files_changed: [],
      artifacts_created: [],
      commands_or_tools_used: [],
      tests_or_verifications: [],
      notable_errors_or_blockers: [],
    },
    session_metadata: {
      organized_at: "2026-06-17T00:00:00+02:00",
      trigger: "manual_skill_invocation",
      transcript_source: "agent_produced",
    },
  };
}

test("missing config fails clearly", () => withTempDir((tempDir) => {
  assert.throws(() => loadConfig(path.join(tempDir, "missing.json")), ConfigError);
}));

test("default config is project-local", () => {
  assert.equal(PROJECT_ROOT, path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  assert.equal(DEFAULT_CONFIG_PATH, path.join(PROJECT_ROOT, "config", "config.json"));
});

test("AGENT_MEMORY_VAULT paths resolve from the project root", () => {
  const config = memoryConfigFromObject(
    {
      provider: "openai",
      chat_model: "chat-test",
      embedding_model: "embedding-test",
      api_key: "test-key",
    },
    { AGENT_MEMORY_VAULT: "vault" },
  );
  assert.equal(config.vaultPath, path.join(PROJECT_ROOT, "vault"));
});

test("AGENT_MEMORY_VAULT is required instead of vault_path", () => {
  assert.throws(
    () =>
      memoryConfigFromObject({
        vault_path: "vault",
        provider: "openai",
        chat_model: "chat-test",
        embedding_model: "embedding-test",
        api_key: "test-key",
      }, {}),
    /Missing required environment variable: AGENT_MEMORY_VAULT/,
  );
});

test("vault root is created when parent exists", () => withTempDir((tempDir) => {
  const vault = path.join(tempDir, "Agent Memory");
  ensureVault(configFor(vault));
  for (const folder of ["inbox", "sources", "archive", "reports", ".index"]) {
    assert.ok(fs.statSync(path.join(vault, folder)).isDirectory());
  }
  assert.ok(fs.existsSync(path.join(vault, "activity-log.md")));
}));

test("missing vault parent fails", () => withTempDir((tempDir) => {
  const vault = path.join(tempDir, "missing", "vault");
  assert.throws(() => ensureVault(configFor(vault)), /parent does not exist/);
}));

test("organize creates memory source note and indexes", async () => withTempDir(async (tempDir) => {
  const vault = path.join(tempDir, "vault");
  const ai = new FakeAI([
    { relevant_slugs: [], new_topic_hints: ["agent memory"], why: "New topic." },
    {
      source_note: {
        title: "Personal Agent Memory Session",
        summary: ["Designed v1 organize and remember skills."],
        decisions: ["Obsidian is canonical."],
        selective_quotes: ["a little bit of magic with receipts"],
        activity: ["Read the PRD."],
        next_session_brief: "Continue implementation.",
      },
      operations: [
        {
          type: "create_memory",
          title: "Personal Agent Memory System",
          suggested_slug: "personal-agent-memory-system",
          confidence: "high",
          sections: {
            summary: ["Obsidian stores durable agent memory."],
            current_decisions: ["Use AI for routing and extraction."],
            preferences_and_guidance: ["Keep reports compact."],
            tasks: ["Implement remember retrieval."],
            open_questions: [],
            explorations: [],
            timeline: ["2026-06-17: v1 PRD accepted."],
          },
        },
      ],
    },
  ]);
  const result = await organizeSession(configFor(vault), ai, sessionRecord());
  assert.equal(ai.responseSchemas[1], EXTRACTOR_RESPONSE_SCHEMA);
  assert.match(result.humanReport, /Updated 1 memory file/);
  const memory = loadMemory(path.join(vault, "personal-agent-memory-system"));
  assert.equal(memory.status, "active");
  assert.ok(memory.sections.current_decisions.includes("Use AI for routing and extraction."));
  assert.equal(fs.readdirSync(path.join(vault, "sources")).filter((file) => file.endsWith(".md")).length, 1);
  assert.ok(fs.existsSync(path.join(vault, ".index", "inventory.json")));
  const embeddings = JSON.parse(fs.readFileSync(path.join(vault, ".index", "embeddings.json"), "utf8"));
  assert.equal(embeddings.memories.length, 1);
}));

test("organize rolls back memory, source, metadata, and indexes when embedding rebuild fails", async () =>
  withTempDir(async (tempDir) => {
    const vault = path.join(tempDir, "vault");
    const config = configFor(vault);
    await organizeSession(config, new FakeAI([
      { relevant_slugs: [], why: "New memory." },
      {
        source_note: { title: "Initial" },
        operations: [{
          type: "create_memory",
          title: "Transactional Memory",
          suggested_slug: "transactional-memory",
          confidence: "high",
          sections: { summary: ["Previously committed content."] },
        }],
      },
    ]), sessionRecord());

    const memoryPath = path.join(vault, "transactional-memory", "memory.md");
    const metadataPath = path.join(vault, "transactional-memory", "metadata.json");
    const inventoryPath = path.join(vault, ".index", "inventory.json");
    const embeddingsPath = path.join(vault, ".index", "embeddings.json");
    const before = {
      memory: fs.readFileSync(memoryPath, "utf8"),
      metadata: fs.readFileSync(metadataPath, "utf8"),
      inventory: fs.readFileSync(inventoryPath, "utf8"),
      embeddings: fs.readFileSync(embeddingsPath, "utf8"),
      sources: fs.readdirSync(path.join(vault, "sources")).sort(),
    };

    const failingAi = new FailingNthEmbeddingAI([
      { relevant_slugs: ["transactional-memory"], why: "Update it." },
      {
        source_note: { title: "Failed Update" },
        operations: [{
          type: "update_memory",
          slug: "transactional-memory",
          confidence: "high",
          section_updates: { summary: ["Uncommitted content."] },
          supersedes: [],
          conflicts: [],
        }],
      },
    ], 2);

    await assert.rejects(
      () => organizeSession(config, failingAi, sessionRecord()),
      /Injected embedding failure/,
    );
    assert.equal(fs.readFileSync(memoryPath, "utf8"), before.memory);
    assert.equal(fs.readFileSync(metadataPath, "utf8"), before.metadata);
    assert.equal(fs.readFileSync(inventoryPath, "utf8"), before.inventory);
    assert.equal(fs.readFileSync(embeddingsPath, "utf8"), before.embeddings);
    assert.deepEqual(fs.readdirSync(path.join(vault, "sources")).sort(), before.sources);
  }));

test("startup recovery restores an interrupted transaction before the vault is used", async () =>
  withTempDir(async (tempDir) => {
    const vault = ensureVault(configFor(path.join(tempDir, "vault")));
    createMemory(vault, {
      title: "Recovery Memory",
      suggested_slug: "recovery-memory",
      confidence: "high",
      sections: { summary: ["Committed state."] },
    });
    const memoryFile = path.join(vault, "recovery-memory", "memory.md");
    const committed = fs.readFileSync(memoryFile, "utf8");
    let markMutationStarted = () => {};
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    let allowOperationToFinish = () => {};
    const operationMayFinish = new Promise<void>((resolve) => {
      allowOperationToFinish = resolve;
    });

    const interrupted = runVaultTransaction(vault, "organize", async () => {
      fs.writeFileSync(memoryFile, "# Partially applied state\n");
      markMutationStarted();
      await operationMayFinish;
    });
    await mutationStarted;
    assert.notEqual(fs.readFileSync(memoryFile, "utf8"), committed);

    assert.equal(recoverVaultTransactions(vault), 1);
    assert.equal(fs.readFileSync(memoryFile, "utf8"), committed);
    allowOperationToFinish();
    await interrupted;
  }));

test("dry run does not write memory or source notes", async () => withTempDir(async (tempDir) => {
  const vault = path.join(tempDir, "vault");
  const ai = new FakeAI([
    { relevant_slugs: [], why: "New topic." },
    {
      source_note: { title: "Dry Run" },
      operations: [
        {
          type: "create_memory",
          title: "Dry Run Memory",
          suggested_slug: "dry-run-memory",
          confidence: "medium",
          sections: { summary: ["Planned only."] },
        },
      ],
    },
  ]);
  const result = await organizeSession(configFor(vault), ai, sessionRecord(), true);
  assert.match(result.humanReport, /Would update/);
  assert.equal(fs.existsSync(path.join(vault, "dry-run-memory")), false);
  assert.equal(fs.readdirSync(path.join(vault, "sources")).filter((file) => file.endsWith(".md")).length, 0);
}));

test("update supersedes conflicts and scrubs secrets", async () => withTempDir(async (tempDir) => {
  const vault = path.join(tempDir, "vault");
  await organizeSession(configFor(vault), new FakeAI([
    { relevant_slugs: [], why: "New." },
    {
      source_note: { title: "Initial" },
      operations: [
        {
          type: "create_memory",
          title: "Preference",
          suggested_slug: "preference",
          confidence: "medium",
          sections: {
            summary: ["Old direction"],
            current_decisions: ["Use a deterministic taxonomy."],
          },
        },
      ],
    },
  ]), sessionRecord());

  await organizeSession(configFor(vault), new FakeAI([
    { relevant_slugs: ["preference"], why: "Update same memory." },
    {
      source_note: { title: "Update" },
      operations: [
        {
          type: "update_memory",
          slug: "preference",
          confidence: "high",
          section_updates: {
            current_decisions: ["Let topic folders emerge organically."],
            preferences_and_guidance: ["api_key=sk-secretvalue1234567890"],
            timeline: ["Changed from fixed taxonomy."],
          },
          supersedes: ["Use a deterministic taxonomy."],
          conflicts: ["Whether cleanup should migrate folders."],
        },
      ],
    },
  ]), sessionRecord());

  const memory = loadMemory(path.join(vault, "preference"));
  assert.equal(memory.sections.current_decisions.includes("Use a deterministic taxonomy."), false);
  assert.ok(memory.sections.current_decisions.includes("Let topic folders emerge organically."));
  assert.ok(memory.sections.timeline.includes("Superseded: Use a deterministic taxonomy."));
  assert.ok(memory.sections.open_questions.some((item) => item.includes("Conflict to resolve")));
  assert.ok(memory.sections.preferences_and_guidance.some((item) => item.includes("[omitted secret-like value]")));
}));

test("deactivated memories are ignored by remember", async () => withTempDir(async (tempDir) => {
  const vault = path.join(tempDir, "vault");
  await organizeSession(configFor(vault), new FakeAI([
    { relevant_slugs: [], why: "New." },
    {
      source_note: { title: "Initial" },
      operations: [
        {
          type: "create_memory",
          title: "Old Memory",
          suggested_slug: "old-memory",
          confidence: "medium",
          sections: { summary: ["Old context."] },
        },
      ],
    },
  ]), sessionRecord());

  await organizeSession(configFor(vault), new FakeAI([
    { relevant_slugs: ["old-memory"], why: "Deactivate." },
    {
      source_note: {
        title: "Deactivation",
        summary: [],
        decisions: [],
        selective_quotes: [],
        activity: [],
        next_session_brief: "",
      },
      operations: [
        {
          type: "deactivate_memory",
          slug: "old-memory",
          reason: "Superseded.",
        },
      ],
    },
  ]), sessionRecord());

  assert.equal(loadMemory(path.join(vault, "old-memory")).status, "inactive");
  const result = await rememberTopic(configFor(vault), new FakeAI([
    { memories: [{ slug: "old-memory", why_loaded: "Should not load" }] },
  ]), "old memory");
  assert.deepEqual(result.packets, []);
}));

test("remember returns packets with why and guidance", async () => withTempDir(async (tempDir) => {
  const vault = path.join(tempDir, "vault");
  await organizeSession(configFor(vault), new FakeAI([
    { relevant_slugs: [], why: "New." },
    {
      source_note: { title: "Initial" },
      operations: [
        {
          type: "create_memory",
          title: "Agent Memory",
          suggested_slug: "agent-memory",
          confidence: "high",
          sections: {
            summary: ["Memory system context."],
            preferences_and_guidance: ["Be concise about loaded memories."],
          },
        },
      ],
    },
  ]), sessionRecord());

  const result = await rememberTopic(configFor(vault), new FakeAI([
    {
      memories: [
        {
          slug: "agent-memory",
          why_loaded: "Directly matches the topic.",
          needed_sections: ["summary", "preferences_and_guidance"],
        },
      ],
      agent_guidance: ["Treat retrieved guidance as advisory."],
    },
  ]), "agent memory implementation");
  assert.equal(result.memory_note, "Loaded memories: Agent Memory.");
  const packets = result.packets as JsonObject[];
  assert.equal(packets[0].why_loaded, "Directly matches the topic.");
  assert.equal((result.agent_guidance as JsonObject).advisory, true);
}));

test("rebuild regenerates indexes from canonical files", async () => withTempDir(async (tempDir) => {
  const vault = path.join(tempDir, "vault");
  await organizeSession(configFor(vault), new FakeAI([
    { relevant_slugs: [], why: "New." },
    {
      source_note: { title: "Initial" },
      operations: [
        {
          type: "create_memory",
          title: "Rebuild Memory",
          suggested_slug: "rebuild-memory",
          confidence: "medium",
          sections: { summary: ["Index me."] },
        },
      ],
    },
  ]), sessionRecord());
  fs.unlinkSync(path.join(vault, ".index", "inventory.json"));
  fs.unlinkSync(path.join(vault, ".index", "embeddings.json"));
  const report = await rebuildIndexes(vault, new FakeAI(), "embed-test");
  assert.equal(report.inventory_count, 1);
  assert.ok(fs.existsSync(path.join(vault, ".index", "inventory.json")));
}));

test("failed standalone rebuild preserves the committed indexes and metadata", async () =>
  withTempDir(async (tempDir) => {
    const vault = path.join(tempDir, "vault");
    const config = configFor(vault);
    await organizeSession(config, new FakeAI([
      { relevant_slugs: [], why: "New." },
      {
        source_note: { title: "Initial" },
        operations: [{
          type: "create_memory",
          title: "Stable Index",
          suggested_slug: "stable-index",
          confidence: "high",
          sections: { summary: ["Keep the previous index usable."] },
        }],
      },
    ]), sessionRecord());
    const files = [
      path.join(vault, ".index", "inventory.json"),
      path.join(vault, ".index", "embeddings.json"),
      path.join(vault, "stable-index", "metadata.json"),
    ];
    const committed = files.map((file) => fs.readFileSync(file, "utf8"));

    await assert.rejects(
      () => rebuildIndexes(
        vault,
        new FailingNthEmbeddingAI([], 1),
        config.embeddingModel,
      ),
      /Injected embedding failure/,
    );
    assert.deepEqual(
      files.map((file) => fs.readFileSync(file, "utf8")),
      committed,
    );
  }));

test("low confidence new memories go to inbox", async () => withTempDir(async (tempDir) => {
  const vault = path.join(tempDir, "vault");
  await organizeSession(configFor(vault), new FakeAI([
    { relevant_slugs: [], why: "Maybe new." },
    {
      source_note: { title: "Low Confidence" },
      operations: [
        {
          type: "create_memory",
          title: "Uncertain Thought",
          suggested_slug: "uncertain-thought",
          confidence: "low",
          sections: { explorations: ["Might be useful later."] },
        },
      ],
    },
  ]), sessionRecord());
  assert.ok(fs.existsSync(path.join(vault, "inbox", "uncertain-thought", "memory.md")));
  const records = discoverMemories(vault);
  assert.equal(records[0].slug, "inbox/uncertain-thought");
}));

test("organize rejects extractor responses outside the strict schema", async () => withTempDir(async (tempDir) => {
  const vault = path.join(tempDir, "vault");
  const ai = new FakeAI([
    { relevant_slugs: [], why: "New." },
    {
      memory_operations: [
        {
          operation: "create",
          name: "Wrong Shape",
        },
      ],
    },
  ]);

  await assert.rejects(
    () => organizeSession(configFor(vault), ai, sessionRecord(), true),
    /Extractor response must match schema/,
  );
  assert.equal(ai.responseSchemas[1], EXTRACTOR_RESPONSE_SCHEMA);
}));
