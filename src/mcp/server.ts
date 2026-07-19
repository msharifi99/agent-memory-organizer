import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ErrorCode,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { scrubSecretText } from "../memory-system/vault.ts";
import { ReadWriteCoordinator } from "./coordinator.ts";
import { withModelTiming } from "./timing.ts";

export type AccessIdentity = {
  subject: string;
};

export type MemoryMcpOperations = {
  remember(topic: string): Promise<Record<string, unknown>>;
  organize(sessionRecord: Record<string, unknown>): Promise<Record<string, unknown>>;
  rebuildIndex(): Promise<Record<string, unknown>>;
  initVault(): Promise<Record<string, unknown>>;
  listMemories(cursor?: string): Promise<Record<string, unknown>>;
  getMemory(slug: string): Promise<Record<string, unknown>>;
};

export type AuditEvent = Record<string, unknown> & {
  event: string;
  request_id: string;
  subject: string;
  outcome: "success" | "error";
  queue_ms: number;
  total_ms: number;
};

export type McpLogEvent = Record<string, unknown> & {
  event: string;
  request_id: string;
};

export type McpHttpServerOptions = {
  authenticate: (
    request: IncomingMessage,
  ) => AccessIdentity | undefined | Promise<AccessIdentity | undefined>;
  operations: MemoryMcpOperations;
  isReady?: () => boolean;
  log?: (event: McpLogEvent) => void;
};

const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const MUTATING_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const ORGANIZE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const REBUILD_INDEX_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const TOOL_OUTPUT_SCHEMA = z.object({}).passthrough();

function jsonToolResult(value: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function loggedToolError(
  code: string,
  message: string,
  tool: string,
  input: Record<string, unknown>,
  requestId: string | number,
  httpRequestId: string,
  identity: AccessIdentity,
  log: ((event: McpLogEvent) => void) | undefined,
): CallToolResult {
  const result = { error: { code, message } };
  log?.({
    event: "tool_call",
    request_id: String(requestId),
    http_request_id: httpRequestId,
    subject: identity.subject,
    tool,
    outcome: "error",
    queue_ms: 0,
    model_ms: 0,
    total_ms: 0,
    input: scrubLogValue(input),
    result,
  });
  return { ...jsonToolResult(result), isError: true };
}

function scrubLogValue(value: unknown): unknown {
  if (typeof value === "string") return scrubSecretText(value);
  if (Array.isArray(value)) return value.map(scrubLogValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        scrubLogValue(item),
      ]),
    );
  }
  return value;
}

function errorLogFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error_type: typeof error };
  return {
    error_name: error.name,
    error_message: scrubSecretText(error.message),
  };
}

async function executeTool(
  coordinator: ReadWriteCoordinator,
  mode: "read" | "write",
  tool: string,
  input: Record<string, unknown>,
  requestId: string | number,
  httpRequestId: string,
  identity: AccessIdentity,
  log: ((event: McpLogEvent) => void) | undefined,
  operation: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  const startedAt = performance.now();
  let queueMilliseconds = 0;
  let modelMilliseconds = 0;
  try {
    const result = await coordinator[mode](
      () =>
        withModelTiming(operation, (elapsed) => {
          modelMilliseconds = elapsed;
        }),
      (elapsed) => {
        queueMilliseconds = elapsed;
      },
    );
    log?.({
      event: "tool_call",
      request_id: String(requestId),
      http_request_id: httpRequestId,
      subject: identity.subject,
      tool,
      outcome: "success",
      queue_ms: Number(queueMilliseconds.toFixed(3)),
      model_ms: Number(modelMilliseconds.toFixed(3)),
      total_ms: Number((performance.now() - startedAt).toFixed(3)),
      input: scrubLogValue(input),
      result: scrubLogValue(result),
    });
    return jsonToolResult(result);
  } catch (error) {
    const result = {
      error: { code: "operation_failed", message: "Operation failed." },
    };
    log?.({
      event: "tool_call",
      request_id: String(requestId),
      http_request_id: httpRequestId,
      subject: identity.subject,
      tool,
      outcome: "error",
      queue_ms: Number(queueMilliseconds.toFixed(3)),
      model_ms: Number(modelMilliseconds.toFixed(3)),
      total_ms: Number((performance.now() - startedAt).toFixed(3)),
      input: scrubLogValue(input),
      result,
      ...errorLogFields(error),
    });
    return { ...jsonToolResult(result), isError: true };
  }
}

function createProtocolServer(
  operations: MemoryMcpOperations,
  coordinator: ReadWriteCoordinator,
  identity: AccessIdentity,
  httpRequestId: string,
  log?: (event: McpLogEvent) => void,
): McpServer {
  const server = new McpServer({
    name: "personal-agent-memory",
    version: "0.1.0",
  }, {
    instructions:
      "Use list_memories or get_memory for browsing. Use remember for topic-specific context. Use organize only after the user intends to persist durable memory changes.",
  });

  server.registerTool(
    "remember",
    {
      description: "Use this when you need compact durable context for an explicit topic.",
      inputSchema: { topic: z.string().trim().min(1) },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ topic }, extra) =>
      executeTool(
        coordinator,
        "read",
        "remember",
        { topic },
        extra.requestId,
        httpRequestId,
        identity,
        log,
        () => operations.remember(topic),
      ),
  );
  server.registerTool(
    "organize",
    {
      description:
        "Use this when the user wants to extract and persist durable memory from a structured session record.",
      inputSchema: {
        session_record: z.object({
          transcript: z.string(),
          activity_appendix: z.record(z.string(), z.unknown()).optional(),
          session_metadata: z.record(z.string(), z.unknown()).optional(),
        }),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: ORGANIZE_ANNOTATIONS,
    },
    async ({ session_record }, extra) =>
      executeTool(
        coordinator,
        "write",
        "organize",
        { session_record },
        extra.requestId,
        httpRequestId,
        identity,
        log,
        () => operations.organize(session_record),
      ),
  );
  server.registerTool(
    "rebuild_index",
    {
      description:
        "Use this when derived memory indexes must be rebuilt from canonical records.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: REBUILD_INDEX_ANNOTATIONS,
    },
    async (extra) =>
      executeTool(
        coordinator,
        "write",
        "rebuild_index",
        {},
        extra.requestId,
        httpRequestId,
        identity,
        log,
        () => operations.rebuildIndex(),
      ),
  );
  server.registerTool(
    "init_vault",
    {
      description: "Use this when the configured vault structure must be initialized.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (extra) =>
      executeTool(
        coordinator,
        "write",
        "init_vault",
        {},
        extra.requestId,
        httpRequestId,
        identity,
        log,
        () => operations.initVault(),
      ),
  );
  server.registerTool(
    "list_memories",
    {
      description: "Use this when you need to browse curated durable memories in stable slug order.",
      inputSchema: { cursor: z.string().optional() },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ cursor }, extra) =>
      executeTool(
        coordinator,
        "read",
        "list_memories",
        { cursor },
        extra.requestId,
        httpRequestId,
        identity,
        log,
        () => operations.listMemories(cursor),
      ),
  );
  server.registerTool(
    "get_memory",
    {
      description: "Use this when you need to read one curated durable memory by slug.",
      inputSchema: { slug: z.string().trim().min(1) },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ slug }, extra) =>
      executeTool(
        coordinator,
        "read",
        "get_memory",
        { slug },
        extra.requestId,
        httpRequestId,
        identity,
        log,
        () => operations.getMemory(slug),
      ),
  );

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const input =
      request.params.arguments && typeof request.params.arguments === "object"
        ? request.params.arguments
        : {};
    if (request.params.name === "remember") {
      if (typeof input.topic !== "string" || !input.topic.trim()) {
        return loggedToolError(
          "invalid_arguments",
          "Invalid tool arguments.",
          request.params.name,
          input,
          extra.requestId,
          httpRequestId,
          identity,
          log,
        );
      }
      return executeTool(
        coordinator,
        "read",
        "remember",
        input,
        extra.requestId,
        httpRequestId,
        identity,
        log,
        () => operations.remember(String(input.topic)),
      );
    }
    if (request.params.name === "organize") {
      const sessionRecord = input.session_record;
      if (
        !sessionRecord ||
        typeof sessionRecord !== "object" ||
        Array.isArray(sessionRecord) ||
        typeof (sessionRecord as Record<string, unknown>).transcript !== "string" ||
        Object.hasOwn(input, "dry_run")
      ) {
        return loggedToolError(
          "invalid_arguments",
          "Invalid tool arguments.",
          request.params.name,
          input,
          extra.requestId,
          httpRequestId,
          identity,
          log,
        );
      }
      return executeTool(
        coordinator,
        "write",
        "organize",
        input,
        extra.requestId,
        httpRequestId,
        identity,
        log,
        () => operations.organize(sessionRecord as Record<string, unknown>),
      );
    }
    if (request.params.name === "rebuild_index") {
      return executeTool(
        coordinator,
        "write",
        "rebuild_index",
        input,
        extra.requestId,
        httpRequestId,
        identity,
        log,
        () => operations.rebuildIndex(),
      );
    }
    if (request.params.name === "init_vault") {
      return executeTool(
        coordinator,
        "write",
        "init_vault",
        input,
        extra.requestId,
        httpRequestId,
        identity,
        log,
        () => operations.initVault(),
      );
    }
    if (request.params.name === "list_memories") {
      if (input.cursor !== undefined && typeof input.cursor !== "string") {
        return loggedToolError(
          "invalid_arguments",
          "Invalid tool arguments.",
          request.params.name,
          input,
          extra.requestId,
          httpRequestId,
          identity,
          log,
        );
      }
      return executeTool(
        coordinator,
        "read",
        "list_memories",
        input,
        extra.requestId,
        httpRequestId,
        identity,
        log,
        () => operations.listMemories(input.cursor as string | undefined),
      );
    }
    if (request.params.name === "get_memory") {
      if (typeof input.slug !== "string" || !input.slug.trim()) {
        return loggedToolError(
          "invalid_arguments",
          "Invalid tool arguments.",
          request.params.name,
          input,
          extra.requestId,
          httpRequestId,
          identity,
          log,
        );
      }
      return executeTool(
        coordinator,
        "read",
        "get_memory",
        input,
        extra.requestId,
        httpRequestId,
        identity,
        log,
        () => operations.getMemory(String(input.slug)),
      );
    }
    return loggedToolError(
      "unknown_tool",
      "Unknown tool.",
      request.params.name,
      input,
      extra.requestId,
      httpRequestId,
      identity,
      log,
    );
  });

  server.server.registerCapabilities({ resources: {} });
  server.server.setRequestHandler(
    ListResourcesRequestSchema,
    async (request, extra) => {
      const startedAt = performance.now();
      let queueMilliseconds = 0;
      const result = await coordinator.read(
        () => operations.listMemories(request.params?.cursor),
        (elapsed) => {
          queueMilliseconds = elapsed;
        },
      );
      const memories = Array.isArray(result.memories)
        ? (result.memories as Record<string, unknown>[])
        : [];
      log?.({
        event: "resource_list",
        request_id: String(extra.requestId),
        http_request_id: httpRequestId,
        subject: identity.subject,
        outcome: "success",
        queue_ms: Number(queueMilliseconds.toFixed(3)),
        total_ms: Number((performance.now() - startedAt).toFixed(3)),
        cursor: scrubLogValue(request.params?.cursor),
        resource_count: memories.length,
        has_next_page: typeof result.next_cursor === "string",
      });
      return {
        resources: memories.map((memory) => ({
          uri: memoryUri(String(memory.slug)),
          name: String(memory.slug),
          title: String(memory.title ?? memory.slug),
          description: `Durable ${String(memory.status ?? "unknown")} memory`,
          mimeType: "text/markdown",
          _meta: memory,
        })),
        nextCursor:
          typeof result.next_cursor === "string" ? result.next_cursor : undefined,
      };
    },
  );
  server.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (_request, extra) => {
      log?.({
        event: "resource_template_list",
        request_id: String(extra.requestId),
        http_request_id: httpRequestId,
        subject: identity.subject,
        outcome: "success",
        resource_template_count: 1,
      });
      return {
        resourceTemplates: [
          {
            name: "memory-by-slug",
            title: "Durable memory by slug",
            uriTemplate: "memory://memories/{+slug}",
            description:
              "Canonical Markdown and safe metadata for a curated memory.",
            mimeType: "text/markdown",
          },
        ],
      };
    },
  );
  server.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const startedAt = performance.now();
    const slug = slugFromMemoryUri(request.params.uri);
    if (!slug) {
      log?.({
        event: "resource_read",
        request_id: String(extra.requestId),
        http_request_id: httpRequestId,
        subject: identity.subject,
        outcome: "error",
        total_ms: Number((performance.now() - startedAt).toFixed(3)),
        uri: scrubLogValue(request.params.uri),
        error_code: "invalid_resource_uri",
      });
      throw new McpError(ErrorCode.InvalidParams, "Memory resource not found.");
    }
    let memory: Record<string, unknown>;
    let queueMilliseconds = 0;
    try {
      memory = await coordinator.read(
        () => operations.getMemory(slug),
        (elapsed) => {
          queueMilliseconds = elapsed;
        },
      );
    } catch (error) {
      log?.({
        event: "resource_read",
        request_id: String(extra.requestId),
        http_request_id: httpRequestId,
        subject: identity.subject,
        outcome: "error",
        queue_ms: Number(queueMilliseconds.toFixed(3)),
        total_ms: Number((performance.now() - startedAt).toFixed(3)),
        slug: scrubLogValue(slug),
        ...errorLogFields(error),
      });
      throw new McpError(ErrorCode.InvalidParams, "Memory resource not found.");
    }
    log?.({
      event: "resource_read",
      request_id: String(extra.requestId),
      http_request_id: httpRequestId,
      subject: identity.subject,
      outcome: "success",
      queue_ms: Number(queueMilliseconds.toFixed(3)),
      total_ms: Number((performance.now() - startedAt).toFixed(3)),
      slug: scrubLogValue(slug),
      markdown_length: String(memory.markdown ?? "").length,
    });
    return {
      contents: [
        {
          uri: String(memory.uri),
          mimeType: "text/markdown",
          text: String(memory.markdown ?? ""),
          _meta:
            memory.metadata && typeof memory.metadata === "object"
              ? (memory.metadata as Record<string, unknown>)
              : {},
        },
      ],
    };
  });

  return server;
}

function memoryUri(slug: string): string {
  return `memory://memories/${slug.split("/").map(encodeURIComponent).join("/")}`;
}

function slugFromMemoryUri(value: string): string | undefined {
  try {
    const uri = new URL(value);
    if (uri.protocol !== "memory:" || uri.hostname !== "memories") return undefined;
    const slug = uri.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent)
      .join("/");
    return slug || undefined;
  } catch {
    return undefined;
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function createMcpHttpServer(options: McpHttpServerOptions): Server {
  const coordinator = new ReadWriteCoordinator();
  return createServer(async (request, response) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    let identity: AccessIdentity | undefined;
    let requestError: unknown;
    let logged = false;
    const logRequest = (aborted: boolean) => {
      if (logged) return;
      logged = true;
      options.log?.({
        event: "http_request",
        request_id: requestId,
        ...(identity ? { subject: identity.subject } : {}),
        method: request.method ?? "UNKNOWN",
        path: new URL(request.url ?? "/", "http://localhost").pathname,
        status_code: response.statusCode,
        outcome: response.statusCode < 400 && !aborted ? "success" : "error",
        aborted,
        total_ms: Number((performance.now() - startedAt).toFixed(3)),
        protocol_version: request.headers["mcp-protocol-version"],
        content_type: request.headers["content-type"],
        content_length: request.headers["content-length"],
        user_agent: scrubLogValue(request.headers["user-agent"]),
        ...(requestError ? errorLogFields(requestError) : {}),
      });
    };
    response.once("finish", () => logRequest(false));
    response.once("close", () => logRequest(!response.writableFinished));

    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

      if (request.method === "GET" && pathname === "/healthz") {
        writeJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && pathname === "/readyz") {
        const ready = options.isReady?.() ?? true;
        writeJson(response, ready ? 200 : 503, {
          status: ready ? "ready" : "unavailable",
        });
        return;
      }

      if (pathname === "/mcp") {
        identity = await options.authenticate(request);
        if (!identity) {
          writeJson(response, 401, {
            error: {
              code: "unauthorized",
              message: "Authentication required.",
            },
          });
          return;
        }

        if (request.method !== "POST") {
          writeJson(response, 405, {
            error: { code: "method_not_allowed", message: "Method not allowed." },
          });
          return;
        }

        const protocolServer = createProtocolServer(
          options.operations,
          coordinator,
          identity,
          requestId,
          options.log,
        );
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await protocolServer.connect(transport);
        try {
          await transport.handleRequest(request, response);
        } finally {
          await protocolServer.close();
        }
        return;
      }

      writeJson(response, 404, {
        error: { code: "not_found", message: "Route not found." },
      });
    } catch (error) {
      requestError = error;
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: { code: "internal_error", message: "Internal server error." },
        });
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  });
}
