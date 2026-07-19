import type { Server } from "node:http";

import { OpenAIClient } from "../memory-system/ai.ts";
import { loadConfig } from "../memory-system/config.ts";
import type { MemoryConfig } from "../memory-system/config.ts";
import { ensureVault, recoverVaultTransactions } from "../memory-system/vault.ts";
import { createCloudflareAccessAuthenticator } from "./auth.ts";
import { createMemoryMcpOperations } from "./operations.ts";
import { createMcpHttpServer } from "./server.ts";

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

export type McpRuntimeConfig = {
  teamDomain: string;
  audience: string;
  host: string;
  port: number;
};

export function loadMcpRuntimeConfig(
  memoryConfig: MemoryConfig,
  environment: Record<string, string | undefined> = process.env,
): McpRuntimeConfig {
  const missing = [
    !memoryConfig.cloudflareAccessTeamDomain && "cloudflare_access_team_domain",
    !memoryConfig.cloudflareAccessAudience && "cloudflare_access_audience",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new RuntimeConfigError(
      `Missing required MCP config field(s): ${missing.join(", ")}.`,
    );
  }
  const port = Number(environment.MCP_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RuntimeConfigError("MCP_PORT must be an integer from 1 through 65535.");
  }
  return {
    teamDomain: memoryConfig.cloudflareAccessTeamDomain!,
    audience: memoryConfig.cloudflareAccessAudience!,
    host: environment.MCP_HOST?.trim() || "0.0.0.0",
    port,
  };
}

export async function startMemoryMcpService(): Promise<{
  server: Server;
  runtime: McpRuntimeConfig;
}> {
  const memoryConfig = loadConfig();
  const runtime = loadMcpRuntimeConfig(memoryConfig);
  const vault = ensureVault(memoryConfig);
  recoverVaultTransactions(vault);
  const ai = new OpenAIClient(memoryConfig);
  const server = createMcpHttpServer({
    authenticate: createCloudflareAccessAuthenticator({
      teamDomain: runtime.teamDomain,
      audience: runtime.audience,
    }),
    operations: createMemoryMcpOperations(memoryConfig, ai),
    isReady: () => true,
    log: (event) => {
      const level =
        event.outcome !== "error"
          ? "info"
          : event.event === "http_request" && Number(event.status_code) < 500
            ? "warn"
            : "error";
      process.stdout.write(
        `${JSON.stringify({ timestamp: new Date().toISOString(), level, ...event })}\n`,
      );
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtime.port, runtime.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, runtime };
}
