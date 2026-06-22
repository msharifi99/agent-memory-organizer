import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_ENV_VAR = "AGENT_MEMORY_CONFIG";
export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".agent-memory", "config.json");

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type MemoryConfig = {
  vaultPath: string;
  provider: string;
  chatModel: string;
  embeddingModel: string;
  apiKey: string;
  apiBase: string;
  maxEmbeddingCandidates: number;
  maxRouterCandidates: number;
};

type RawConfig = Record<string, unknown>;

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function expandEnv(value: string): string {
  return value.replace(/%([^%]+)%|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, winName, unixName) => {
    const name = String(winName || unixName);
    return process.env[name] ?? "";
  });
}

export function expandPath(value: string): string {
  return path.resolve(expandEnv(expandHome(value)));
}

export function memoryConfigFromObject(raw: RawConfig): MemoryConfig {
  const required = ["vault_path", "provider", "chat_model", "embedding_model", "api_key"];
  const missing = required.filter((key) => !raw[key]);
  if (missing.length > 0) {
    throw new ConfigError(`Memory config is missing required field(s): ${missing.join(", ")}.`);
  }

  return {
    vaultPath: expandPath(String(raw.vault_path)),
    provider: String(raw.provider).toLowerCase(),
    chatModel: String(raw.chat_model),
    embeddingModel: String(raw.embedding_model),
    apiKey: String(raw.api_key),
    apiBase: String(raw.api_base ?? "https://api.openai.com").replace(/\/+$/, ""),
    maxEmbeddingCandidates: Number(raw.max_embedding_candidates ?? 12),
    maxRouterCandidates: Number(raw.max_router_candidates ?? 8),
  };
}

export function configPath(): string {
  const override = process.env[CONFIG_ENV_VAR];
  return override ? expandPath(override) : DEFAULT_CONFIG_PATH;
}

export function loadConfig(selectedPath?: string): MemoryConfig {
  const selected = selectedPath ? expandPath(selectedPath) : configPath();
  if (!fs.existsSync(selected)) {
    throw new ConfigError(`Memory config not found at ${selected}. Create it or set ${CONFIG_ENV_VAR}.`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(selected, "utf8"));
  } catch (error) {
    throw new ConfigError(`Memory config at ${selected} is not valid JSON: ${String(error)}`);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`Memory config at ${selected} must be a JSON object.`);
  }
  return memoryConfigFromObject(raw as RawConfig);
}
