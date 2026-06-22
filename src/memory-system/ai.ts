import type { MemoryConfig } from "./config.ts";

export type JsonObject = Record<string, unknown>;

export type JsonSchemaFormat = {
  name: string;
  schema: JsonObject;
  strict?: boolean;
};

export interface AIClient {
  embed(text: string): Promise<number[]> | number[];
  chatJson(
    systemPrompt: string,
    userPayload: JsonObject,
    responseSchema?: JsonSchemaFormat,
  ): Promise<JsonObject> | JsonObject;
}

export class AIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIError";
  }
}

export class OpenAIClient implements AIClient {
  private config: MemoryConfig;

  constructor(config: MemoryConfig) {
    if (config.provider !== "openai") {
      throw new AIError(`Unsupported provider '${config.provider}'. v1 supports 'openai'.`);
    }
    this.config = config;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.postJson("/v1/embeddings", {
      model: this.config.embeddingModel,
      input: text,
    });
    const embedding = (((response.data as unknown[])?.[0] as JsonObject | undefined)?.embedding ?? []) as unknown[];
    if (!Array.isArray(embedding)) {
      throw new AIError("Embedding response did not contain a usable embedding.");
    }
    return embedding.map((value) => Number(value));
  }

  async chatJson(
    systemPrompt: string,
    userPayload: JsonObject,
    responseSchema?: JsonSchemaFormat,
  ): Promise<JsonObject> {
    const response = await this.postJson("/v1/chat/completions", {
      model: this.config.chatModel,
      response_format: responseSchema
        ? {
            type: "json_schema",
            json_schema: {
              name: responseSchema.name,
              strict: responseSchema.strict ?? true,
              schema: responseSchema.schema,
            },
          }
        : { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
    });
    const content = (((response.choices as unknown[])?.[0] as JsonObject | undefined)?.message as JsonObject | undefined)?.content;
    if (typeof content !== "string") {
      throw new AIError("Chat response did not contain a JSON string.");
    }
    try {
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      return parsed as JsonObject;
    } catch (error) {
      throw new AIError(`Chat response did not contain a JSON object: ${String(error)}`);
    }
  }

  private async postJson(apiPath: string, body: JsonObject): Promise<JsonObject> {
    const response = await fetch(`${this.config.apiBase}${apiPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AIError(`AI request failed with HTTP ${response.status}: ${text}`);
    }
    return JSON.parse(text) as JsonObject;
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
