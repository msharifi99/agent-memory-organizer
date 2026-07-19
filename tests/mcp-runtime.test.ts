import assert from "node:assert/strict";
import test from "node:test";

import { loadMcpRuntimeConfig, RuntimeConfigError } from "../src/mcp/runtime.ts";
import type { MemoryConfig } from "../src/memory-system/config.ts";

const memoryConfig: MemoryConfig = {
  vaultPath: "/tmp/vault",
  provider: "openai",
  chatModel: "gpt-5-mini",
  embeddingModel: "text-embedding-3-small",
  apiKey: "test-key",
  apiBase: "https://api.openai.com",
  maxEmbeddingCandidates: 12,
  maxRouterCandidates: 8,
};

test("MCP runtime requires Cloudflare Access team and application audience in the config file", () => {
  assert.throws(
    () => loadMcpRuntimeConfig(memoryConfig),
    (error) =>
      error instanceof RuntimeConfigError &&
      error.message ===
        "Missing required MCP config field(s): cloudflare_access_team_domain, cloudflare_access_audience.",
  );

  assert.deepEqual(
    loadMcpRuntimeConfig({
      ...memoryConfig,
      cloudflareAccessTeamDomain: "owner.cloudflareaccess.com",
      cloudflareAccessAudience: "memory-audience",
    }, {
      MCP_HOST: "127.0.0.1",
      MCP_PORT: "3456",
    }),
    {
      teamDomain: "owner.cloudflareaccess.com",
      audience: "memory-audience",
      host: "127.0.0.1",
      port: 3456,
    },
  );
});
