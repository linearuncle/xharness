import Anthropic from "@anthropic-ai/sdk";
import type { Config, EffortLevel } from "../config.js";
import type { RawStreamEvent, StreamFn, StreamRequestParams } from "./client.js";

/**
 * Anthropic Messages 格式的 streamFn（本项目唯一接触 @anthropic-ai/sdk 的模块）。
 * effort 映射（Judge T7 裁决 b）：
 * - none → 只传 thinking:{type:"disabled"}（实测唯一可靠关闭方式），不传 reasoning
 *   以避免上游修复 effort 后的歧义；
 * - low/high/max → 透传 reasoning.effort（DeepSeek Anthropic 端点扩展字段）；
 * - 未设置 → 两者皆不携带（端点默认 high）。
 */
export function createAnthropicStreamFn(config: Config): StreamFn {
  const sdk = new Anthropic({
    // authToken 设置时走 Authorization: Bearer（OAuth access token），
    // 此时 apiKey 必须为 null 以免 SDK 同时发 x-api-key
    apiKey: config.authToken ? null : config.apiKey,
    authToken: config.authToken ?? null,
    baseURL: config.baseUrl,
    maxRetries: 0,
  });
  return async (params: StreamRequestParams, signal) => {
    const request: Anthropic.MessageCreateParamsStreaming = {
      model: params.model,
      max_tokens: params.max_tokens,
      system: params.system,
      messages: params.messages as unknown as Anthropic.MessageParam[],
      tools: params.tools as unknown as Anthropic.ToolUnion[],
      stream: true,
    };
    if (params.effort === "none") {
      // thinking 是 SDK 原生 ThinkingConfigParam，无需 as
      request.thinking = { type: "disabled" };
    } else if (params.effort) {
      // reasoning 是 DeepSeek Anthropic 端点扩展字段，SDK 类型不认识，最小范围 as 透传
      (
        request as Anthropic.MessageCreateParamsStreaming & {
          reasoning?: { effort: EffortLevel };
        }
      ).reasoning = { effort: params.effort };
    }
    const stream = await sdk.messages.create(request, { signal });
    return stream as unknown as AsyncIterable<RawStreamEvent>;
  };
}
