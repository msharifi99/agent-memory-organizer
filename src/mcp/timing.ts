import { AsyncLocalStorage } from "node:async_hooks";

import type { AIClient, JsonObject, JsonSchemaFormat } from "../memory-system/ai.ts";

type ModelTiming = {
  milliseconds: number;
};

const modelTiming = new AsyncLocalStorage<ModelTiming>();

export async function withModelTiming<T>(
  operation: () => Promise<T>,
  onComplete: (milliseconds: number) => void,
): Promise<T> {
  const timing: ModelTiming = { milliseconds: 0 };
  return modelTiming.run(timing, async () => {
    try {
      return await operation();
    } finally {
      onComplete(timing.milliseconds);
    }
  });
}

async function timeModelCall<T>(operation: () => Promise<T> | T): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    const timing = modelTiming.getStore();
    if (timing) timing.milliseconds += performance.now() - startedAt;
  }
}

export function instrumentAIClient(ai: AIClient): AIClient {
  return {
    embed: (text: string) => timeModelCall(() => ai.embed(text)),
    chatJson: (
      systemPrompt: string,
      userPayload: JsonObject,
      responseSchema?: JsonSchemaFormat,
    ) =>
      timeModelCall(() =>
        ai.chatJson(systemPrompt, userPayload, responseSchema),
      ),
  };
}
