import fs from "node:fs";
import path from "node:path";

import type { AIClient, JsonObject, JsonSchemaFormat } from "./ai.ts";
import type { MemoryConfig } from "./config.ts";
import { SECTION_TITLES } from "./markdown.ts";
import type { SectionKey } from "./markdown.ts";
import {
  createMemory,
  deactivateMemory,
  discoverMemories,
  ensureVault,
  normalizeSlug,
  rebuildIndexes,
  scrubSecretText,
  topEmbeddingCandidates,
  updateMemory,
  utcNow,
  writeJson,
} from "./vault.ts";
import type { MemoryRecord } from "./vault.ts";

export const ORGANIZE_ROUTER_PROMPT = `Select existing memories that may be relevant to organizing this session.
Return JSON with keys: relevant_slugs (array of strings), new_topic_hints (array of strings), why (string).
Use semantic judgment. Prefer inclusion when a memory may be updated, contradicted, or useful as context.`;

export const EXTRACTOR_PROMPT = `Extract durable memory operations from the session.
Return only JSON that matches the provided response schema exactly.
Top-level keys must be source_note and operations.
Use these exact operation shapes:
- create_memory: type, title, suggested_slug, aliases, kind, confidence, sections
- update_memory: type, slug, title, aliases, confidence, section_updates, supersedes, conflicts
- deactivate_memory: type, slug, reason, replacement_slug
- append_source_note: type, reason
- generate_next_session_brief: type, slug, brief
- no_op: type, reason
Do not preserve raw secrets. Use create/update sections: summary, current_decisions, preferences_and_guidance, tasks, open_questions, explorations, timeline.
Put speculative ideas in explorations or open_questions. Put agent behavior advice in preferences_and_guidance.`;

const textArraySchema = {
  type: "array",
  items: { type: "string" },
} as const;

const memorySectionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: textArraySchema,
    current_decisions: textArraySchema,
    preferences_and_guidance: textArraySchema,
    tasks: textArraySchema,
    open_questions: textArraySchema,
    explorations: textArraySchema,
    timeline: textArraySchema,
  },
  required: [
    "summary",
    "current_decisions",
    "preferences_and_guidance",
    "tasks",
    "open_questions",
    "explorations",
    "timeline",
  ],
} as const;

export const EXTRACTOR_RESPONSE_SCHEMA: JsonSchemaFormat = {
  name: "memory_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      source_note: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          summary: textArraySchema,
          decisions: textArraySchema,
          selective_quotes: textArraySchema,
          activity: textArraySchema,
          next_session_brief: { type: "string" },
        },
        required: [
          "title",
          "summary",
          "decisions",
          "selective_quotes",
          "activity",
          "next_session_brief",
        ],
      },
      operations: {
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { enum: ["create_memory"] },
                title: { type: "string" },
                suggested_slug: { type: "string" },
                aliases: textArraySchema,
                kind: { type: "string" },
                confidence: { enum: ["low", "medium", "high"] },
                sections: memorySectionsSchema,
              },
              required: [
                "type",
                "title",
                "suggested_slug",
                "aliases",
                "kind",
                "confidence",
                "sections",
              ],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { enum: ["update_memory"] },
                slug: { type: "string" },
                title: { type: "string" },
                aliases: textArraySchema,
                confidence: { enum: ["low", "medium", "high"] },
                section_updates: memorySectionsSchema,
                supersedes: textArraySchema,
                conflicts: textArraySchema,
              },
              required: [
                "type",
                "slug",
                "title",
                "aliases",
                "confidence",
                "section_updates",
                "supersedes",
                "conflicts",
              ],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { enum: ["deactivate_memory"] },
                slug: { type: "string" },
                reason: { type: "string" },
                replacement_slug: { type: "string" },
              },
              required: ["type", "slug", "reason", "replacement_slug"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { enum: ["append_source_note"] },
                reason: { type: "string" },
              },
              required: ["type", "reason"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { enum: ["generate_next_session_brief"] },
                slug: { type: "string" },
                brief: { type: "string" },
              },
              required: ["type", "slug", "brief"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { enum: ["no_op"] },
                reason: { type: "string" },
              },
              required: ["type", "reason"],
            },
          ],
        },
      },
    },
    required: ["source_note", "operations"],
  },
};

export const REMEMBER_ROUTER_PROMPT = `Choose memories useful for the declared session topic.
Return JSON with keys:
- memories: array of objects with slug, why_loaded, needed_sections
- agent_guidance: array of advisory strings
- next_session_brief: optional object with slug and text
The topic is a soft scope. Exclude inactive memories and explain every loaded memory.`;

export type OrganizeResult = {
  humanReport: string;
  agentReport: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function assertExtractorResponse(value: JsonObject): void {
  const sourceNote = asRecord(value.source_note);
  if (!sourceNote.title || !Array.isArray(value.operations)) {
    throw new Error(
      "Extractor response must match schema: { source_note: { title, summary, decisions, selective_quotes, activity, next_session_brief }, operations: [...] }.",
    );
  }
  for (const item of value.operations) {
    const operation = asRecord(item);
    if (!operation.type) {
      throw new Error("Extractor operation is missing required field: type.");
    }
  }
}

export function candidatePayload(
  candidates: [MemoryRecord, number][],
): Record<string, unknown>[] {
  return candidates.map(([record, score]) => ({
    slug: record.slug,
    title: record.title,
    aliases: record.aliases,
    kind: record.kind,
    confidence: record.confidence,
    score: Number(score.toFixed(4)),
    summary: record.sections.summary.slice(0, 5),
    current_decisions: record.sections.current_decisions.slice(0, 8),
    open_questions: record.sections.open_questions.slice(0, 5),
  }));
}

export function sessionQuery(sessionRecord: Record<string, unknown>): string {
  const transcript = String(sessionRecord.transcript || "");
  const appendix = JSON.stringify(sessionRecord.activity_appendix || {});
  return `${transcript}\n\nActivity appendix:\n${appendix}`.slice(0, 12000);
}

export function makeSourceNote(
  vault: string,
  sourceNote: Record<string, unknown>,
  sessionRecord: Record<string, unknown>,
  dryRun: boolean,
): string {
  const title = String(sourceNote.title || "Organized Session");
  const slug = normalizeSlug(title);
  const timestamp = utcNow().replace(/[:+]/g, "").replace(/Z$/, "Z");
  const sourceRef = `sources/${timestamp}-${slug}`;
  const filePath = path.join(vault, `${sourceRef}.md`);
  const metadata = asRecord(sessionRecord.session_metadata);

  const lines = [`# ${title}`, ""];
  lines.push(`- Organized at: ${String(metadata.organized_at || utcNow())}`);
  lines.push("- Transcript source: agent_produced", "");
  for (const [heading, key] of [
    ["Summary", "summary"],
    ["Session Decisions", "decisions"],
    ["Selective Quotes", "selective_quotes"],
    ["Activity", "activity"],
    ["Next Session Brief", "next_session_brief"],
  ]) {
    lines.push(`## ${heading}`);
    const raw = sourceNote[key];
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (items.length > 0) {
      for (const item of items)
        lines.push(`- ${scrubSecretText(String(item))}`);
    } else {
      lines.push("- None recorded.");
    }
    lines.push("");
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${lines.join("\n").trimEnd()}\n`, "utf8");
  }
  return sourceRef;
}

function operationIsMeaningful(operation: Record<string, unknown>): boolean {
  return operation.type != null && operation.type !== "no_op";
}

export async function organizeSession(
  config: MemoryConfig,
  ai: AIClient,
  sessionRecord: Record<string, unknown>,
  dryRun = false,
): Promise<OrganizeResult> {
  const vault = ensureVault(config);
  console.log("vault", vault);
  const candidates = await topEmbeddingCandidates(
    vault,
    ai,
    sessionQuery(sessionRecord),
    config.maxEmbeddingCandidates,
  );
  console.log(
    `Found ${candidates.length} candidate memories for organizing.`,
    candidates
      .map(([record, score]) => `- ${record.slug} (score: ${score.toFixed(4)})`)
      .join("\n"),
  );
  const router = await ai.chatJson(ORGANIZE_ROUTER_PROMPT, {
    session: sessionRecord,
    candidates: candidatePayload(candidates),
  });
  const relevant = new Set(asArray(router.relevant_slugs).map(String));
  const selectedRecords = candidates
    .filter(([record]) => relevant.has(record.slug))
    .slice(0, config.maxRouterCandidates)
    .map(([record]) => ({
      slug: record.slug,
      title: record.title,
      metadata: record.metadata,
      sections: record.sections,
    }));

  const extraction = await ai.chatJson(
    EXTRACTOR_PROMPT,
    {
      session: sessionRecord,
      router,
      selected_memories: selectedRecords,
      allowed_operations: [
        "create_memory",
        "update_memory",
        "append_source_note",
        "generate_next_session_brief",
        "deactivate_memory",
        "no_op",
      ],
    },
    EXTRACTOR_RESPONSE_SCHEMA,
  );
  assertExtractorResponse(extraction);
  console.log("Extraction result:", JSON.stringify(extraction, null, 2));

  const operations = asArray(extraction.operations).filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item),
  );
  const meaningful = operations.filter(operationIsMeaningful);
  const sourceRef =
    meaningful.length > 0
      ? makeSourceNote(
          vault,
          asRecord(extraction.source_note),
          sessionRecord,
          dryRun,
        )
      : undefined;

  const changedSlugs: string[] = [];
  const noOps: string[] = [];
  for (const operation of operations) {
    console.log("Processing operation:", operation);
    const opType = operation.type;
    if (opType === "create_memory") {
      const slug = normalizeSlug(
        String(operation.suggested_slug || operation.title || "memory"),
        String(operation.confidence || "").toLowerCase() === "low",
      );
      changedSlugs.push(
        dryRun ? slug : createMemory(vault, operation, sourceRef),
      );
    } else if (opType === "update_memory") {
      const slug = normalizeSlug(String(operation.slug || ""));
      changedSlugs.push(
        dryRun ? slug : updateMemory(vault, operation, sourceRef),
      );
    } else if (opType === "deactivate_memory") {
      const slug = normalizeSlug(String(operation.slug || ""));
      changedSlugs.push(dryRun ? slug : deactivateMemory(vault, operation));
    } else if (
      opType === "append_source_note" ||
      opType === "generate_next_session_brief"
    ) {
      continue;
    } else if (opType === "no_op") {
      noOps.push(String(operation.reason || "No reusable memory found."));
    } else {
      throw new Error(`Unsupported operation type: ${String(opType)}`);
    }
  }

  let indexReport: Record<string, number> = {
    inventory_count: 0,
    embedding_count: 0,
  };
  if (!dryRun && changedSlugs.length > 0) {
    indexReport = await rebuildIndexes(vault, ai, config.embeddingModel);
    appendActivityLog(vault, changedSlugs, sourceRef);
  }

  let reportPath: string | undefined;
  const reportData = {
    organized_at: utcNow(),
    dry_run: dryRun,
    changed_slugs: changedSlugs,
    source_note: sourceRef,
    router,
    no_ops: noOps,
    index: indexReport,
  };
  if (!dryRun) {
    reportPath = path.join(
      vault,
      "reports",
      `${utcNow().replace(/:/g, "")}-organize-report.json`,
    );
    writeJson(reportPath, reportData);
  }

  const action = dryRun ? "Would update" : "Updated";
  let human =
    changedSlugs.length > 0
      ? `${action} ${changedSlugs.length} memory file(s): ${changedSlugs.join(", ")}.`
      : noOps[0] || "No durable memory changes were needed.";
  if (sourceRef) human += ` Source note: ${sourceRef}.`;

  return {
    humanReport: human,
    agentReport: {
      ...reportData,
      report_path: reportPath,
      advisory:
        "Saved memory is advisory context for future sessions, not an override of live instructions.",
    },
  };
}

export function appendActivityLog(
  vault: string,
  changedSlugs: string[],
  sourceRef?: string,
): void {
  const lines = [
    `\n## ${utcNow()}`,
    `- Changed memories: ${changedSlugs.join(", ")}`,
  ];
  if (sourceRef) lines.push(`- Source note: [[${sourceRef}]]`);
  fs.appendFileSync(
    path.join(vault, "activity-log.md"),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

export function compactSections(
  record: MemoryRecord,
  neededSections: string[],
): Record<string, string[]> {
  const selected =
    neededSections.length > 0
      ? neededSections
      : [
          "summary",
          "current_decisions",
          "preferences_and_guidance",
          "tasks",
          "open_questions",
        ];
  const allowed = new Set(Object.keys(SECTION_TITLES));
  const result: Record<string, string[]> = {};
  for (const key of selected) {
    if (allowed.has(key))
      result[key] = record.sections[key as SectionKey].slice(0, 8);
  }
  return result;
}

export async function rememberTopic(
  config: MemoryConfig,
  ai: AIClient,
  topic: string,
): Promise<Record<string, unknown>> {
  if (!topic.trim())
    throw new Error("Remember requires an explicit topic or scope.");
  const vault = ensureVault(config);
  const candidates = await topEmbeddingCandidates(
    vault,
    ai,
    topic,
    config.maxEmbeddingCandidates,
  );
  const router = await ai.chatJson(REMEMBER_ROUTER_PROMPT, {
    topic,
    candidates: candidatePayload(candidates),
  });
  const records = new Map(
    discoverMemories(vault, false).map((record) => [record.slug, record]),
  );
  const packets: Record<string, unknown>[] = [];
  for (const item of asArray(router.memories)) {
    const memoryRequest = asRecord(item);
    const slug = String(memoryRequest.slug || "");
    const record = records.get(slug);
    if (!record) continue;
    packets.push({
      slug,
      title: record.title,
      why_loaded: String(
        memoryRequest.why_loaded || "Relevant to the declared topic.",
      ),
      factual_context: compactSections(
        record,
        asArray(memoryRequest.needed_sections).map(String),
      ),
      advisory_guidance: record.sections.preferences_and_guidance.slice(0, 8),
      source_note_refs: record.metadata.source_note_refs || [],
    });
  }
  const noteNames = packets.map((packet) => packet.title).join(", ") || "none";
  return {
    topic,
    memory_note: `Loaded memories: ${noteNames}.`,
    packets,
    agent_guidance: {
      advisory: true,
      items: asArray(router.agent_guidance).map(String),
    },
    next_session_brief: router.next_session_brief,
  };
}
