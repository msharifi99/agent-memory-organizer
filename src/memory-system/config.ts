import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_ENV_VAR = "AGENT_MEMORY_CONFIG";
export const VAULT_ENV_VAR = "AGENT_MEMORY_VAULT";
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config", "config.json");

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
  cloudflareAccessTeamDomain?: string;
  cloudflareAccessAudience?: string;
};

type RawConfig = Record<string, unknown>;

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function expandEnv(
  value: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  return value.replace(/%([^%]+)%|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, winName, unixName) => {
    const name = String(winName || unixName);
    return environment[name] ?? "";
  });
}

export function expandPath(
  value: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  return path.resolve(expandEnv(expandHome(value), environment));
}

function expandProjectPath(
  value: string,
  environment: Record<string, string | undefined>,
): string {
  return path.resolve(PROJECT_ROOT, expandEnv(expandHome(value), environment));
}

export function memoryConfigFromObject(
  raw: RawConfig,
  environment: Record<string, string | undefined> = process.env,
): MemoryConfig {
  const required = ["provider", "chat_model", "embedding_model", "api_key"];
  const missing = required.filter((key) => !raw[key]);
  if (missing.length > 0) {
    throw new ConfigError(`Memory config is missing required field(s): ${missing.join(", ")}.`);
  }
  const vaultPath = environment[VAULT_ENV_VAR]?.trim();
  if (!vaultPath) {
    throw new ConfigError(`Missing required environment variable: ${VAULT_ENV_VAR}.`);
  }

  return {
    vaultPath: expandProjectPath(vaultPath, environment),
    provider: String(raw.provider).toLowerCase(),
    chatModel: String(raw.chat_model),
    embeddingModel: String(raw.embedding_model),
    apiKey: String(raw.api_key),
    apiBase: String(raw.api_base ?? "https://api.openai.com").replace(/\/+$/, ""),
    maxEmbeddingCandidates: Number(raw.max_embedding_candidates ?? 12),
    maxRouterCandidates: Number(raw.max_router_candidates ?? 8),
    cloudflareAccessTeamDomain: nonEmptyString(raw.cloudflare_access_team_domain),
    cloudflareAccessAudience: nonEmptyString(raw.cloudflare_access_audience),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function configPath(
  environment: Record<string, string | undefined> = process.env,
): string {
  const override = environment[CONFIG_ENV_VAR];
  return override ? expandPath(override, environment) : DEFAULT_CONFIG_PATH;
}

export function loadConfig(
  selectedPath?: string,
  environment: Record<string, string | undefined> = process.env,
): MemoryConfig {
  const selected = selectedPath
    ? expandPath(selectedPath, environment)
    : configPath(environment);
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
  return memoryConfigFromObject(raw as RawConfig, environment);
}
