import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { OpenAIClient } from "./ai.ts";
import type { AIClient, JsonObject } from "./ai.ts";
import { loadConfig } from "./config.ts";
import { ensureVault, rebuildIndexes } from "./vault.ts";
import { organizeSession, rememberTopic } from "./workflows.ts";

class StubAI implements AIClient {
  private responses: JsonObject[];

  constructor(responses: JsonObject[]) {
    this.responses = [...responses];
  }

  embed(text: string): number[] {
    const total = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return Array.from(
      { length: 16 },
      (_value, offset) => ((total + offset) % 97) / 97,
    );
  }

  chatJson(_systemPrompt: string, _userPayload: JsonObject): JsonObject {
    const response = this.responses.shift();
    if (!response) throw new Error("No stub AI response left for chatJson.");
    return response;
  }
}

function readJson(filePath: string): JsonObject {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonObject;
}

function buildAI(
  config: ReturnType<typeof loadConfig>,
  stubFiles: string[],
): AIClient {
  if (stubFiles.length > 0) return new StubAI(stubFiles.map(readJson));
  return new OpenAIClient(config);
}

type ParsedArgs = {
  command?: string;
  config?: string;
  session?: string;
  topic?: string;
  dryRun: boolean;
  stubFiles: string[];
  help: boolean;
};

function printHelp(command?: string): void {
  if (command === "organize") {
    console.log(
      "usage: memory-system organize [--config PATH] --session PATH [--dry-run] [--stub-ai-json PATH]",
    );
    return;
  }
  if (command === "remember") {
    console.log(
      "usage: memory-system remember [--config PATH] --topic TOPIC [--stub-ai-json PATH]",
    );
    return;
  }
  console.log(
    "usage: memory-system <organize|remember|rebuild-index|init-vault> [options]",
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { dryRun: false, stubFiles: [], help: false };
  parsed.command = argv.shift();
  while (argv.length > 0) {
    const arg = argv.shift();
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--config") parsed.config = argv.shift();
    else if (arg === "--session") parsed.session = argv.shift();
    else if (arg === "--topic") parsed.topic = argv.shift();
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--stub-ai-json") {
      const file = argv.shift();
      if (file) parsed.stubFiles.push(file);
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs([...argv]);
  } catch (error) {
    console.error(`memory-system: ${String(error)}`);
    return 1;
  }

  if (args.help || !args.command) {
    printHelp(args.command);
    return 0;
  }

  try {
    const config = loadConfig(args.config);
    const ai = buildAI(config, args.stubFiles);

    if (args.command === "organize") {
      if (!args.session) throw new Error("organize requires --session.");
      const result = await organizeSession(
        config,
        ai,
        readJson(args.session),
        args.dryRun,
      );
      console.log(result.humanReport);
      console.log(JSON.stringify(result.agentReport, null, 2));
    } else if (args.command === "remember") {
      if (!args.topic) throw new Error("remember requires --topic.");
      console.log(
        JSON.stringify(await rememberTopic(config, ai, args.topic), null, 2),
      );
    } else if (args.command === "rebuild-index") {
      const vault = ensureVault(config);
      console.log(
        JSON.stringify(
          await rebuildIndexes(vault, ai, config.embeddingModel),
          null,
          2,
        ),
      );
    } else if (args.command === "init-vault") {
      console.log(`Initialized vault at ${ensureVault(config)}`);
    } else {
      throw new Error(`Unknown command: ${args.command}`);
    }
    return 0;
  } catch (error) {
    console.error("An error occurred during execution:");
    console.error(
      `memory-system: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
