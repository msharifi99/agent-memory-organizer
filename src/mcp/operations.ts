import fs from "node:fs";
import path from "node:path";

import type { AIClient } from "../memory-system/ai.ts";
import type { MemoryConfig } from "../memory-system/config.ts";
import {
  discoverMemories,
  ensureVault,
  memoryPath,
  rebuildIndexes,
} from "../memory-system/vault.ts";
import type { MemoryRecord } from "../memory-system/vault.ts";
import { organizeSession, rememberTopic } from "../memory-system/workflows.ts";
import type { MemoryMcpOperations } from "./server.ts";
import { instrumentAIClient } from "./timing.ts";

const PAGE_SIZE = 100;

function curatedMemories(vault: string): MemoryRecord[] {
  return discoverMemories(vault, true).filter((record) => {
    try {
      return path.resolve(record.path) === path.resolve(memoryPath(vault, record.slug));
    } catch {
      return false;
    }
  });
}

function safeMetadata(record: MemoryRecord): Record<string, unknown> {
  return {
    slug: record.slug,
    title: record.title,
    aliases: record.aliases,
    kind: record.kind,
    status: record.status,
    confidence: record.confidence,
    created_at: record.metadata.created_at,
    updated_at: record.metadata.updated_at,
  };
}

function memoryUri(slug: string): string {
  const encodedSlug = slug.split("/").map(encodeURIComponent).join("/");
  return `memory://memories/${encodedSlug}`;
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const offset = Number(decoded);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid offset");
    return offset;
  } catch {
    throw new Error("Invalid memory cursor.");
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function browsePage(vault: string, cursor?: string): Record<string, unknown> {
  const records = curatedMemories(vault);
  const offset = decodeCursor(cursor);
  const page = records.slice(offset, offset + PAGE_SIZE);
  const nextOffset = offset + page.length;
  return {
    memories: page.map(safeMetadata),
    next_cursor: nextOffset < records.length ? encodeCursor(nextOffset) : null,
  };
}

function readMemory(vault: string, slug: string): Record<string, unknown> {
  const record = curatedMemories(vault).find((candidate) => candidate.slug === slug);
  if (!record) throw new Error("Memory not found.");
  return {
    uri: memoryUri(record.slug),
    metadata: safeMetadata(record),
    markdown: fs.readFileSync(path.join(record.path, "memory.md"), "utf8"),
  };
}

export function createMemoryMcpOperations(
  config: MemoryConfig,
  ai: AIClient,
): MemoryMcpOperations {
  const timedAi = instrumentAIClient(ai);
  return {
    remember: (topic) => rememberTopic(config, timedAi, topic),
    organize: async (sessionRecord) => {
      const result = await organizeSession(
        config,
        timedAi,
        sessionRecord,
      );
      const { report_path: _reportPath, ...safeReport } = result.agentReport;
      return safeReport;
    },
    rebuildIndex: async () => {
      const vault = ensureVault(config);
      return rebuildIndexes(vault, timedAi, config.embeddingModel);
    },
    initVault: async () => {
      ensureVault(config);
      return { initialized: true };
    },
    listMemories: async (cursor) => browsePage(ensureVault(config), cursor),
    getMemory: async (slug) => readMemory(ensureVault(config), slug),
  };
}
