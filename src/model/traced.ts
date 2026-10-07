import type { Model } from "./model.ts";
import { traceOperation } from "../tracing.ts";

/** Records each reply as a Langfuse generation: the prompt, the reply, when output started, and the usage. */
export function tracedModel(provider: string, modelId: string, model: Model): Model {
  return {
    reply(messages, tools, onDelta, signal) {
      return traceOperation(`${provider.toLowerCase()}.chat`, "generation", {
        model: modelId, input: messages, metadata: { provider: provider.toLowerCase(), tools },
      }, async (update) => {
        let started = false;
        const reply = await model.reply(messages, tools, (text) => {
          if (!started) {
            started = true;
            update({ completionStartTime: new Date() });
          }
          onDelta?.(text);
        }, signal);
        update({
          output: reply.message,
          usageDetails: {
            input: Math.max(0, reply.usage.promptTokens - (reply.usage.cachedTokens ?? 0)),
            output: reply.usage.completionTokens,
            ...(reply.usage.cachedTokens == null ? {} : { input_cached_tokens: reply.usage.cachedTokens }),
          },
          costDetails: { total: reply.usage.costUsd },
        });
        return reply;
      });
    },
  };
}
