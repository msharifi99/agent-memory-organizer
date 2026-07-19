import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { cosineSimilarity } from "./ai.ts";
import type { AIClient } from "./ai.ts";
import type { MemoryConfig } from "./config.ts";
import {
  SECTION_TITLES,
  emptySections,
  mergeSectionItems,
  normalizeItems,
  parseMemory,
  renderMemory,
} from "./markdown.ts";
import type { SectionKey, Sections } from "./markdown.ts";

export const SYSTEM_FOLDERS = [
  "inbox",
  "sources",
  "archive",
  "reports",
  ".index",
] as const;

const TRANSACTIONS_FOLDER = ".transactions";

const SECRET_PATTERNS = [
  /\b(api[_-]?key|secret|password|token|credential)\b\s*[:=]\s*\S+/gi,
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b[A-Za-z]:[\\/][^\s"'`]+/g,
  /\/(?:home|mnt|Users|srv|data|run|tmp|etc|var)\/[^\s"'`]+/g,
];

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export type MemoryMetadata = Record<string, unknown> & {
  slug: string;
  title?: string;
  aliases?: string[];
  kind?: string;
  status?: string;
  confidence?: string;
  source_note_refs?: string[];
  embedding_source_hash?: string;
};

export type MemoryRecord = {
  slug: string;
  title: string;
  aliases: string[];
  kind: string;
  status: string;
  confidence: string;
  path: string;
  metadata: MemoryMetadata;
  sections: Sections;
};

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function scrubSecretText(text: string): string {
  return SECRET_PATTERNS.reduce(
    (scrubbed, pattern) =>
      scrubbed.replace(pattern, "[omitted secret-like value]"),
    text,
  );
}

export function scrubItems(items: string[]): string[] {
  return items.map((item) => scrubSecretText(item));
}

export function stableHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function slugify(value: string, fallback = "memory"): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || fallback;
}

export function normalizeSlug(value: string, lowConfidence = false): string {
  if (!value || typeof value !== "string")
    throw new VaultError("Memory slug is required.");
  const parts = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.trim())
    .map((part) => slugify(part));
  if (parts.length === 0)
    throw new VaultError("Memory slug is empty after normalization.");
  if (parts.length > 2)
    throw new VaultError("Memory slug may contain at most one folder level.");
  if (["sources", "archive", "reports", ".index"].includes(parts[0])) {
    parts[0] = `memory-${parts[0]}`;
  }
  if (lowConfidence && parts[0] !== "inbox") {
    return `inbox/${parts.at(-1)}`;
  }
  return parts.join("/");
}

export function memoryPath(vaultPath: string, slug: string): string {
  const normalized = normalizeSlug(slug);
  const target = path.resolve(vaultPath, ...normalized.split("/"));
  const vault = path.resolve(vaultPath);
  const relative = path.relative(vault, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new VaultError(`Refusing to write outside vault: ${slug}`);
  }
  return target;
}

export function ensureVault(config: MemoryConfig): string {
  const vault = config.vaultPath;
  if (!fs.existsSync(vault)) {
    const parent = path.dirname(vault);
    if (!fs.existsSync(parent))
      throw new VaultError(`Vault parent does not exist: ${parent}`);
    fs.mkdirSync(vault);
  }
  if (!fs.statSync(vault).isDirectory()) {
    throw new VaultError(`Vault path is not a directory: ${vault}`);
  }
  for (const folder of SYSTEM_FOLDERS) {
    fs.mkdirSync(path.join(vault, folder), { recursive: true });
  }
  const activityLog = path.join(vault, "activity-log.md");
  if (!fs.existsSync(activityLog))
    fs.writeFileSync(activityLog, "# Activity Log\n", "utf8");
  return vault;
}

export function loadMemory(memoryFolder: string): MemoryRecord {
  const metadataPath = path.join(memoryFolder, "metadata.json");
  const memoryMdPath = path.join(memoryFolder, "memory.md");
  if (!fs.existsSync(metadataPath) || !fs.existsSync(memoryMdPath)) {
    throw new VaultError(`Memory folder is incomplete: ${memoryFolder}`);
  }
  const metadata = JSON.parse(
    fs.readFileSync(metadataPath, "utf8"),
  ) as MemoryMetadata;
  const parsed = parseMemory(fs.readFileSync(memoryMdPath, "utf8"));
  return {
    slug: String(metadata.slug),
    title: String(metadata.title || parsed.title),
    aliases: Array.isArray(metadata.aliases)
      ? metadata.aliases.map(String)
      : [],
    kind: String(metadata.kind || "topic"),
    status: String(metadata.status || "active"),
    confidence: String(metadata.confidence || "medium"),
    path: memoryFolder,
    metadata,
    sections: parsed.sections,
  };
}

function findMetadataFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === TRANSACTIONS_FOLDER) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMetadataFiles(fullPath));
    } else if (entry.isFile() && entry.name === "metadata.json") {
      files.push(fullPath);
    }
  }
  return files;
}

export function discoverMemories(
  vault: string,
  includeInactive = true,
): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  for (const metadataPath of findMetadataFiles(vault)) {
    const relativeParts = path.relative(vault, metadataPath).split(path.sep);
    if (relativeParts.includes(".index") || relativeParts.includes("sources"))
      continue;
    try {
      const record = loadMemory(path.dirname(metadataPath));
      if (path.resolve(record.path) !== path.resolve(memoryPath(vault, record.slug))) {
        continue;
      }
      if (includeInactive || record.status === "active") records.push(record);
    } catch {
      continue;
    }
  }
  return records.sort((left, right) => left.slug.localeCompare(right.slug));
}

export function embeddingSource(record: MemoryRecord): string {
  const parts = [record.title, record.aliases.join(" ")];
  for (const key of [
    "summary",
    "current_decisions",
    "open_questions",
  ] as SectionKey[]) {
    parts.push(...record.sections[key]);
  }
  return parts.filter(Boolean).join("\n").trim();
}

export function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function rebuildIndexesInActiveTransaction(
  vault: string,
  ai: AIClient,
  embeddingModel: string,
): Promise<Record<string, number>> {
  const records = discoverMemories(vault, true);
  const inventory = {
    generated_at: utcNow(),
    memories: records.map((record) => ({
      slug: record.slug,
      title: record.title,
      aliases: record.aliases,
      kind: record.kind,
      status: record.status,
      confidence: record.confidence,
      path: path.relative(vault, record.path).replace(/\\/g, "/"),
      updated_at: record.metadata.updated_at,
    })),
  };

  const embeddings: Record<string, unknown> = {
    generated_at: utcNow(),
    embedding_model: embeddingModel,
    memories: [],
  };

  for (const record of records) {
    const source = embeddingSource(record);
    const sourceHash = stableHash(source);
    if (record.status === "active" && source) {
      (embeddings.memories as unknown[]).push({
        slug: record.slug,
        status: record.status,
        source_hash: sourceHash,
        embedding: await ai.embed(source),
      });
    }
    if (record.metadata.embedding_source_hash !== sourceHash) {
      record.metadata.embedding_source_hash = sourceHash;
      record.metadata.updated_at = record.metadata.updated_at || utcNow();
      writeJson(path.join(record.path, "metadata.json"), record.metadata);
    }
  }

  const index = path.join(vault, ".index");
  writeJson(path.join(index, "inventory.json"), inventory);
  writeJson(path.join(index, "embeddings.json"), embeddings);
  return {
    inventory_count: records.length,
    embedding_count: (embeddings.memories as unknown[]).length,
  };
}

type TransactionState = {
  version: 1;
  state: "active";
  kind: string;
  created_at: string;
};

function copyDirectoryContents(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === TRANSACTIONS_FOLDER) continue;
    fs.cpSync(path.join(source, entry.name), path.join(destination, entry.name), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
  }
}

function restoreTransaction(vault: string, transactionFolder: string): void {
  const backup = path.join(transactionFolder, "backup");
  for (const entry of fs.readdirSync(vault, { withFileTypes: true })) {
    if (entry.name === TRANSACTIONS_FOLDER) continue;
    fs.rmSync(path.join(vault, entry.name), { recursive: true, force: true });
  }
  if (fs.existsSync(backup)) copyDirectoryContents(backup, vault);
  fs.rmSync(transactionFolder, { recursive: true, force: true });
}

export async function runVaultTransaction<T>(
  vault: string,
  kind: string,
  operation: () => Promise<T>,
): Promise<T> {
  const transactionRoot = path.join(vault, TRANSACTIONS_FOLDER);
  const transactionFolder = path.join(transactionRoot, crypto.randomUUID());
  const backup = path.join(transactionFolder, "backup");
  fs.mkdirSync(backup, { recursive: true });
  copyDirectoryContents(vault, backup);
  writeJson(path.join(transactionFolder, "state.json"), {
    version: 1,
    state: "active",
    kind,
    created_at: utcNow(),
  } satisfies TransactionState);

  try {
    const result = await operation();
    fs.rmSync(transactionFolder, { recursive: true, force: true });
    return result;
  } catch (error) {
    restoreTransaction(vault, transactionFolder);
    throw error;
  }
}

export function recoverVaultTransactions(vault: string): number {
  const transactionRoot = path.join(vault, TRANSACTIONS_FOLDER);
  if (!fs.existsSync(transactionRoot)) return 0;
  let recovered = 0;
  for (const entry of fs.readdirSync(transactionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transactionFolder = path.join(transactionRoot, entry.name);
    const statePath = path.join(transactionFolder, "state.json");
    if (!fs.existsSync(statePath)) {
      fs.rmSync(transactionFolder, { recursive: true, force: true });
      continue;
    }
    restoreTransaction(vault, transactionFolder);
    recovered += 1;
  }
  return recovered;
}

export async function rebuildIndexes(
  vault: string,
  ai: AIClient,
  embeddingModel: string,
): Promise<Record<string, number>> {
  return runVaultTransaction(vault, "rebuild_index", () =>
    rebuildIndexesInActiveTransaction(vault, ai, embeddingModel),
  );
}

export function loadEmbeddings(vault: string): Map<string, number[]> {
  const filePath = path.join(vault, ".index", "embeddings.json");
  const result = new Map<string, number[]>();
  if (!fs.existsSync(filePath)) return result;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
    string,
    unknown
  >;
  for (const item of (raw.memories as Record<string, unknown>[] | undefined) ??
    []) {
    if (item.status === "active" && Array.isArray(item.embedding)) {
      result.set(String(item.slug), item.embedding.map(Number));
    }
  }
  return result;
}

export async function topEmbeddingCandidates(
  vault: string,
  ai: AIClient,
  query: string,
  limit: number,
): Promise<[MemoryRecord, number][]> {
  const records = new Map(
    discoverMemories(vault, false).map((record) => [record.slug, record]),
  );
  const embeddings = loadEmbeddings(vault);
  if (embeddings.size === 0 && records.size > 0) {
    return [...records.values()].slice(0, limit).map((record) => [record, 0]);
  }
  const queryEmbedding = await ai.embed(query);
  const scored: [MemoryRecord, number][] = [];
  for (const [slug, embedding] of embeddings) {
    const record = records.get(slug);
    if (record)
      scored.push([record, cosineSimilarity(queryEmbedding, embedding)]);
  }
  return scored.sort((left, right) => right[1] - left[1]).slice(0, limit);
}

export function sectionPayload(sections: Record<string, unknown>): Sections {
  const payload = emptySections();
  for (const key of Object.keys(SECTION_TITLES) as SectionKey[]) {
    payload[key] = scrubItems(normalizeItems(sections[key]));
  }
  return payload;
}

export function writeMemory(
  vault: string,
  slug: string,
  title: string,
  sections: Sections,
  metadata: MemoryMetadata,
): void {
  const folder = memoryPath(vault, slug);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "memory.md"),
    renderMemory(title, sections),
    "utf8",
  );
  writeJson(path.join(folder, "metadata.json"), metadata);
}

export function createMemory(
  vault: string,
  operation: Record<string, unknown>,
  sourceRef?: string,
): string {
  const confidence = String(operation.confidence || "medium").toLowerCase();
  const slug = normalizeSlug(
    String(operation.suggested_slug || operation.title || "memory"),
    confidence === "low",
  );
  const folder = memoryPath(vault, slug);
  if (fs.existsSync(folder))
    throw new VaultError(
      `Cannot create memory because slug already exists: ${slug}`,
    );
  const title = String(
    operation.title ||
      slug.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()),
  );
  const sections = sectionPayload(
    (operation.sections as Record<string, unknown> | undefined) ?? {},
  );
  if (sourceRef)
    sections.sources = mergeSectionItems(sections.sources, [
      `[[${sourceRef}]]`,
    ]);
  const now = utcNow();
  writeMemory(vault, slug, title, sections, {
    slug,
    title,
    aliases: normalizeItems(operation.aliases),
    kind: String(operation.kind || "topic"),
    created_at: now,
    updated_at: now,
    status: "active",
    confidence,
    embedding_source_hash: "",
    source_note_refs: sourceRef ? [sourceRef] : [],
  });
  return slug;
}

export function updateMemory(
  vault: string,
  operation: Record<string, unknown>,
  sourceRef?: string,
): string {
  const slug = normalizeSlug(String(operation.slug || ""));
  const record = loadMemory(memoryPath(vault, slug));
  const updates =
    (operation.section_updates as Record<string, unknown> | undefined) ?? {};
  const sections = emptySections();
  for (const key of Object.keys(SECTION_TITLES) as SectionKey[])
    sections[key] = [...record.sections[key]];

  const supersedes = scrubItems(normalizeItems(operation.supersedes));
  for (const key of [
    "summary",
    "current_decisions",
    "preferences_and_guidance",
    "tasks",
    "open_questions",
    "explorations",
  ] as SectionKey[]) {
    sections[key] = sections[key].filter((item) => !supersedes.includes(item));
  }

  for (const key of Object.keys(SECTION_TITLES) as SectionKey[]) {
    if (key === "sources") continue;
    sections[key] = mergeSectionItems(
      sections[key],
      scrubItems(normalizeItems(updates[key])),
    );
  }

  const conflicts = scrubItems(normalizeItems(operation.conflicts));
  if (conflicts.length > 0) {
    sections.open_questions = mergeSectionItems(
      sections.open_questions,
      conflicts.map((item) => `Conflict to resolve: ${item}`),
    );
  }
  if (supersedes.length > 0) {
    sections.timeline = mergeSectionItems(
      sections.timeline,
      supersedes.map((item) => `Superseded: ${item}`),
    );
  }
  if (sourceRef)
    sections.sources = mergeSectionItems(sections.sources, [
      `[[${sourceRef}]]`,
    ]);

  const metadata: MemoryMetadata = { ...record.metadata };
  metadata.updated_at = utcNow();
  metadata.confidence = String(
    operation.confidence || metadata.confidence || "medium",
  ).toLowerCase();
  if (operation.title) metadata.title = String(operation.title);
  if (operation.aliases) {
    metadata.aliases = mergeSectionItems(
      Array.isArray(metadata.aliases) ? metadata.aliases.map(String) : [],
      normalizeItems(operation.aliases),
    );
  }
  const sourceRefs = Array.isArray(metadata.source_note_refs)
    ? metadata.source_note_refs
    : [];
  if (sourceRef && !sourceRefs.includes(sourceRef))
    metadata.source_note_refs = [...sourceRefs, sourceRef];
  writeMemory(
    vault,
    slug,
    String(metadata.title || record.title),
    sections,
    metadata,
  );
  return slug;
}

export function deactivateMemory(
  vault: string,
  operation: Record<string, unknown>,
): string {
  const slug = normalizeSlug(String(operation.slug || ""));
  const record = loadMemory(memoryPath(vault, slug));
  const metadata: MemoryMetadata = { ...record.metadata };
  metadata.status = "inactive";
  metadata.updated_at = utcNow();
  metadata.deactivated_reason = scrubSecretText(
    String(operation.reason || "No reason recorded."),
  );
  if (operation.replacement_slug)
    metadata.replacement_slug = normalizeSlug(
      String(operation.replacement_slug),
    );
  const tombstone = emptySections();
  tombstone.summary = [`Inactive memory. ${metadata.deactivated_reason}`];
  if (metadata.replacement_slug)
    tombstone.sources = [`Replacement: [[${metadata.replacement_slug}]]`];
  writeMemory(
    vault,
    slug,
    String(metadata.title || record.title),
    tombstone,
    metadata,
  );
  return slug;
}
