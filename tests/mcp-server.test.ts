import assert from "node:assert/strict";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { AIClient } from "../src/memory-system/ai.ts";
import type { JsonObject, JsonSchemaFormat } from "../src/memory-system/ai.ts";
import type { MemoryConfig } from "../src/memory-system/config.ts";
import {
  createMemory,
  deactivateMemory,
  discoverMemories,
  ensureVault,
} from "../src/memory-system/vault.ts";
import { createMemoryMcpOperations } from "../src/mcp/operations.ts";
import { createMcpHttpServer } from "../src/mcp/server.ts";
import type { McpLogEvent, MemoryMcpOperations } from "../src/mcp/server.ts";

const operations = {
  remember: async () => ({}),
  organize: async () => ({}),
  rebuildIndex: async () => ({}),
  initVault: async () => ({}),
  listMemories: async () => ({}),
  getMemory: async () => ({}),
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withServer(
  callback: (baseUrl: string) => Promise<void>,
  selectedOperations: MemoryMcpOperations = operations,
  isReady: () => boolean = () => true,
  log?: (event: McpLogEvent) => void,
): Promise<void> {
  const server = createMcpHttpServer({
    authenticate: (request: IncomingMessage) =>
      request.headers.authorization === "Bearer valid-access-token"
        ? { subject: "owner" }
        : undefined,
    operations: selectedOperations,
    isReady,
    log,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function withTempDir(
  callback: (tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-"));
  try {
    await callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function configFor(vaultPath: string): MemoryConfig {
  return {
    vaultPath,
    provider: "openai",
    chatModel: "chat-test",
    embeddingModel: "embedding-test",
    apiKey: "test-key",
    apiBase: "https://api.openai.com",
    maxEmbeddingCandidates: 12,
    maxRouterCandidates: 8,
  };
}

const unusedAi: AIClient = {
  embed: async () => {
    throw new Error("AI must not be called while browsing memories.");
  },
  chatJson: async () => {
    throw new Error("AI must not be called while browsing memories.");
  },
};

class FakeAI implements AIClient {
  private readonly responses: JsonObject[];

  constructor(responses: JsonObject[]) {
    this.responses = [...responses];
  }

  embed(text: string): number[] {
    return [text.length || 1, 1];
  }

  chatJson(
    _systemPrompt: string,
    _userPayload: JsonObject,
    _responseSchema?: JsonSchemaFormat,
  ): JsonObject {
    const response = this.responses.shift();
    assert.ok(response, "Unexpected AI call.");
    return response;
  }
}

test("health probe is public while MCP rejects requests without a valid Access identity", async () =>
  withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const mcp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(mcp.status, 401);
    assert.deepEqual(await mcp.json(), {
      error: { code: "unauthorized", message: "Authentication required." },
    });
  }));

test("readiness is minimal and stays unavailable until startup recovery completes", async () => {
  let ready = false;
  await withServer(async (baseUrl) => {
    const unavailable = await fetch(`${baseUrl}/readyz`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { status: "unavailable" });

    ready = true;
    const available = await fetch(`${baseUrl}/readyz`);
    assert.equal(available.status, 200);
    assert.deepEqual(await available.json(), { status: "ready" });
  }, operations, () => ready);
});

test("authenticated clients discover the six memory tools with accurate impact annotations", async () =>
  withServer(async (baseUrl) => {
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: "Bearer valid-access-token" },
      },
    });
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ["get_memory", "init_vault", "list_memories", "organize", "rebuild_index", "remember"],
      );
      assert.deepEqual(tools.find((tool) => tool.name === "remember")?.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      assert.deepEqual(tools.find((tool) => tool.name === "organize")?.annotations, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
      assert.equal(
        "dry_run" in (tools.find((tool) => tool.name === "organize")?.inputSchema.properties ?? {}),
        false,
      );
      assert.deepEqual(tools.find((tool) => tool.name === "rebuild_index")?.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      assert.equal(
        tools.every((tool) => tool.description?.startsWith("Use this when")),
        true,
      );
    } finally {
      await client.close();
    }
  }));

test("browsing tools expose active and inactive curated memories without host paths", async () =>
  withTempDir(async (tempDir) => {
    const vault = ensureVault(configFor(path.join(tempDir, "vault")));
    createMemory(vault, {
      title: "Active Memory",
      suggested_slug: "active-memory",
      confidence: "high",
      sections: { summary: ["Visible active context."] },
    });
    createMemory(vault, {
      title: "Historical Memory",
      suggested_slug: "historical-memory",
      confidence: "medium",
      sections: { summary: ["Visible historical context."] },
    });
    deactivateMemory(vault, {
      slug: "historical-memory",
      reason: "Kept for historical inspection.",
    });
    fs.mkdirSync(path.join(vault, "reports", "not-a-memory"), { recursive: true });
    fs.writeFileSync(
      path.join(vault, "reports", "not-a-memory", "metadata.json"),
      JSON.stringify({ slug: "reports/not-a-memory", title: "Private Report" }),
    );
    fs.writeFileSync(path.join(vault, "reports", "not-a-memory", "memory.md"), "# Private\n");
    assert.equal(
      discoverMemories(vault).some((memory) => memory.title === "Private Report"),
      false,
    );

    const selectedOperations = createMemoryMcpOperations(configFor(vault), unusedAi);
    await withServer(async (baseUrl) => {
      const client = new Client({ name: "integration-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-access-token" } },
      }));

      try {
        const listed = await client.callTool({ name: "list_memories", arguments: {} });
        const listResult = listed.structuredContent as Record<string, unknown>;
        const memories = listResult.memories as Record<string, unknown>[];
        assert.deepEqual(memories.map((memory) => memory.slug), [
          "active-memory",
          "historical-memory",
        ]);
        assert.deepEqual(memories.map((memory) => memory.status), ["active", "inactive"]);
        assert.equal(JSON.stringify(listResult).includes(vault), false);

        const fetched = await client.callTool({
          name: "get_memory",
          arguments: { slug: "historical-memory" },
        });
        const memory = fetched.structuredContent as Record<string, unknown>;
        assert.equal(memory.uri, "memory://memories/historical-memory");
        assert.match(String(memory.markdown), /Kept for historical inspection/);
        assert.equal(JSON.stringify(memory).includes(vault), false);
      } finally {
        await client.close();
      }
    }, selectedOperations);
  }));

test("memory resources paginate 100 at a time and support stable direct reads", async () =>
  withTempDir(async (tempDir) => {
    const config = configFor(path.join(tempDir, "vault"));
    const vault = ensureVault(config);
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, "0");
      createMemory(vault, {
        title: `Memory ${suffix}`,
        suggested_slug: `memory-${suffix}`,
        confidence: "high",
        sections: { summary: [`Context ${suffix}.`] },
      });
    }

    await withServer(async (baseUrl) => {
      const client = new Client({ name: "integration-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-access-token" } },
      }));

      try {
        const firstPage = await client.listResources();
        assert.equal(firstPage.resources.length, 100);
        assert.ok(firstPage.nextCursor);
        assert.equal(firstPage.resources[0].uri, "memory://memories/memory-000");

        const secondPage = await client.listResources({ cursor: firstPage.nextCursor });
        assert.equal(secondPage.resources.length, 1);
        assert.equal(secondPage.nextCursor, undefined);
        assert.equal(secondPage.resources[0].uri, "memory://memories/memory-100");

        const resource = await client.readResource({
          uri: "memory://memories/memory-100",
        });
        assert.ok("text" in resource.contents[0]);
        assert.match(String(resource.contents[0].text), /Context 100/);
        assert.equal(resource.contents[0]._meta?.slug, "memory-100");
        assert.equal(JSON.stringify(resource).includes(vault), false);
      } finally {
        await client.close();
      }
    }, createMemoryMcpOperations(config, unusedAi));
  }));

test("organize writes by default and returns the same JSON in both MCP result fields", async () =>
  withTempDir(async (tempDir) => {
    const config = configFor(path.join(tempDir, "vault"));
    const ai = new FakeAI([
      { relevant_slugs: [], new_topic_hints: ["remote memory"], why: "New topic." },
      {
        source_note: {
          title: "Remote Memory Session",
          summary: ["Designed the remote MCP service."],
          decisions: ["Use Cloudflare Access Managed OAuth."],
          selective_quotes: [],
          activity: [],
          next_session_brief: "Continue the MCP implementation.",
        },
        operations: [
          {
            type: "create_memory",
            title: "Remote Memory MCP",
            suggested_slug: "remote-memory-mcp",
            aliases: [],
            kind: "project",
            confidence: "high",
            sections: {
              summary: ["A remote MCP integration for durable memory."],
              current_decisions: ["Cloudflare Access authenticates remote clients."],
              preferences_and_guidance: [],
              tasks: [],
              open_questions: [],
              explorations: [],
              timeline: [],
            },
          },
        ],
      },
    ]);

    await withServer(async (baseUrl) => {
      const client = new Client({ name: "integration-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-access-token" } },
      }));
      try {
        const result = await client.callTool({
          name: "organize",
          arguments: {
            session_record: { transcript: "We chose Cloudflare Access Managed OAuth." },
          },
        });
        const structured = result.structuredContent as Record<string, unknown>;
        const content = result.content as { type: string; text: string }[];
        assert.deepEqual(structured.changed_slugs, ["remote-memory-mcp"]);
        assert.equal("report_path" in structured, false);
        assert.equal(content[0].type, "text");
        assert.equal(content[0].text, JSON.stringify(structured));
        assert.ok(fs.existsSync(path.join(config.vaultPath, "remote-memory-mcp", "memory.md")));
      } finally {
        await client.close();
      }
    }, createMemoryMcpOperations(config, ai));
  }));

test("organize rejects the CLI-only dry_run option", async () =>
  withServer(async (baseUrl) => {
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: "Bearer valid-access-token" } },
    }));
    try {
      const result = await client.callTool({
        name: "organize",
        arguments: {
          session_record: { transcript: "Do not persist this session." },
          dry_run: true,
        },
      });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, {
        error: { code: "invalid_arguments", message: "Invalid tool arguments." },
      });
    } finally {
      await client.close();
    }
  }));

test("memory reads wait until an active organize write finishes", async () => {
  const writeStarted = deferred();
  const releaseWrite = deferred();
  const events: string[] = [];
  const controlledOperations: MemoryMcpOperations = {
    ...operations,
    organize: async () => {
      events.push("write-started");
      writeStarted.resolve();
      await releaseWrite.promise;
      events.push("write-finished");
      return { changed_slugs: [] };
    },
    getMemory: async () => {
      events.push("read-started");
      return { slug: "memory" };
    },
  };

  await withServer(async (baseUrl) => {
    const makeClient = async () => {
      const client = new Client({ name: "integration-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-access-token" } },
      }));
      return client;
    };
    const writer = await makeClient();
    const reader = await makeClient();
    const calls: Promise<unknown>[] = [];
    try {
      const writeResult = writer.callTool({
        name: "organize",
        arguments: { session_record: { transcript: "Serialize this write." } },
      });
      calls.push(writeResult);
      await writeStarted.promise;
      const readResult = reader.callTool({
        name: "get_memory",
        arguments: { slug: "memory" },
      });
      calls.push(readResult);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(events, ["write-started"]);

      releaseWrite.resolve();
      await Promise.all([writeResult, readResult]);
      assert.deepEqual(events, ["write-started", "write-finished", "read-started"]);
    } finally {
      releaseWrite.resolve();
      await Promise.allSettled(calls);
      await Promise.all([writer.close(), reader.close()]);
    }
  }, controlledOperations);
});

test("tool audit logs are structured, correlated, and scrub secret-like content", async () => {
  const events: McpLogEvent[] = [];
  const secret = "api_key=sk-abcdefghijklmnop123456";
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.signature";
  const hostPath = "/home/owner/private/vault.json";
  const loggingOperations: MemoryMcpOperations = {
    ...operations,
    remember: async () => ({ packets: [{ summary: secret }] }),
  };

  await withServer(async (baseUrl) => {
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: "Bearer valid-access-token" } },
    }));
    try {
      await client.callTool({
        name: "remember",
        arguments: { topic: `Credentials ${secret} ${jwt} ${hostPath}` },
      });
    } finally {
      await client.close();
    }
  }, loggingOperations, () => true, (event) => events.push(event));

  const toolEvent = events.find((event) => event.event === "tool_call");
  const requestEvent = events.find(
    (event) =>
      event.event === "http_request" && event.request_id === toolEvent?.http_request_id,
  );
  assert.ok(toolEvent);
  assert.ok(requestEvent);
  assert.equal(toolEvent.tool, "remember");
  assert.equal(toolEvent.subject, "owner");
  assert.equal(toolEvent.outcome, "success");
  assert.equal(typeof toolEvent.request_id, "string");
  assert.equal(typeof toolEvent.http_request_id, "string");
  assert.equal(typeof toolEvent.queue_ms, "number");
  assert.equal(typeof toolEvent.model_ms, "number");
  assert.equal(typeof toolEvent.total_ms, "number");
  assert.equal(requestEvent.method, "POST");
  assert.equal(requestEvent.path, "/mcp");
  assert.equal(requestEvent.status_code, 200);
  assert.equal(requestEvent.outcome, "success");
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal(JSON.stringify(events).includes(jwt), false);
  assert.equal(JSON.stringify(events).includes(hostPath), false);
  assert.match(JSON.stringify(events), /omitted secret-like value/);
});

test("tool failures log scrubbed diagnostic details", async () => {
  const events: McpLogEvent[] = [];
  const secret = "api_key=sk-abcdefghijklmnop123456";
  const failingOperations: MemoryMcpOperations = {
    ...operations,
    remember: async () => {
      throw new Error(`Provider rejected ${secret}`);
    },
  };

  await withServer(async (baseUrl) => {
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: "Bearer valid-access-token" } },
    }));
    try {
      const result = await client.callTool({
        name: "remember",
        arguments: { topic: "failing operation" },
      });
      assert.equal(result.isError, true);
    } finally {
      await client.close();
    }
  }, failingOperations, () => true, (event) => events.push(event));

  const toolEvent = events.find((event) => event.event === "tool_call");
  assert.ok(toolEvent);
  assert.equal(toolEvent.outcome, "error");
  assert.equal(toolEvent.error_name, "Error");
  assert.equal(JSON.stringify(toolEvent).includes(secret), false);
  assert.match(String(toolEvent.error_message), /omitted secret-like value/);
});

test("tool validation failures use a stable JSON-only error contract", async () =>
  withServer(async (baseUrl) => {
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: "Bearer valid-access-token" } },
    }));
    try {
      const result = await client.callTool({
        name: "remember",
        arguments: { topic: "" },
      });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, {
        error: {
          code: "invalid_arguments",
          message: "Invalid tool arguments.",
        },
      });
      const content = result.content as { type: string; text: string }[];
      assert.equal(content[0].type, "text");
      assert.equal(content[0].text, JSON.stringify(result.structuredContent));
    } finally {
      await client.close();
    }
  }));

test("an accepted organize operation continues after the HTTP client disconnects", async () => {
  const started = deferred();
  const release = deferred();
  const completed = deferred();
  const disconnectOperations: MemoryMcpOperations = {
    ...operations,
    organize: async () => {
      started.resolve();
      await release.promise;
      completed.resolve();
      return { changed_slugs: [] };
    },
  };

  await withServer(async (baseUrl) => {
    const controller = new AbortController();
    const request = fetch(`${baseUrl}/mcp`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: "Bearer valid-access-token",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "organize",
          arguments: { session_record: { transcript: "Keep working." } },
        },
      }),
    }).catch(() => undefined);

    await started.promise;
    controller.abort();
    await request;
    release.resolve();
    await Promise.race([
      completed.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Operation was cancelled.")), 500),
      ),
    ]);
  }, disconnectOperations);
});
