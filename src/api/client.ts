import Anthropic from "@anthropic-ai/sdk";
import type { Config, EffortLevel } from "../config.js";
import type {
  AgentEvent,
  ContentBlock,
  Message,
  StopReason,
  TextBlock,
  Usage,
} from "../types/messages.js";

export class ApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface StreamMessageOptions {
  system: string;
  messages: Message[];
  tools: ApiToolDefinition[];
  model: string;
  maxTokens: number;
  /** thinking 档位；未设置时不传 reasoning 参数（端点默认 high） */
  effort?: EffortLevel;
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

export interface StreamMessageResult {
  content: ContentBlock[];
  stopReason: StopReason;
  /** 本次调用的 token 用量；端点未回报时缺省 */
  usage?: Usage;
}

export interface ApiClient {
  streamMessage(opts: StreamMessageOptions): Promise<StreamMessageResult>;
}

/** 原始流里的 usage 字段（Anthropic 命名） */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export type RawStreamEvent =
  | { type: "message_start"; message?: { usage?: RawUsage } }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "text"; text?: string }
        | { type: "thinking"; thinking?: string }
        | { type: "tool_use"; id: string; name: string; input?: unknown };
    }
  | {
      type: "content_block_delta";
      /** Anthropic 标准要求携带；xAI Anthropic 兼容流实测会省略。 */
      index?: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: StopReason }; usage?: RawUsage }
  | { type: "message_stop" };

export interface StreamRequestParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: Message[];
  tools: ApiToolDefinition[];
  /** DeepSeek Anthropic 端点扩展字段（Thinking Mode）；仅 low/high/max 携带 */
  reasoning?: { effort: EffortLevel };
  /** Anthropic 官方参数；effort:"none" 映射为 {type:"disabled"}（Judge T7 裁决 b） */
  thinking?: { type: "disabled" };
}

export type StreamFn = (
  params: StreamRequestParams,
  signal?: AbortSignal
) => Promise<AsyncIterable<RawStreamEvent>>;

const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000];

function normalizeError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status: unknown }).status) || undefined
      : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError(message, status);
}

function isRetryable(err: ApiError): boolean {
  if (err.status === undefined) return true; // 网络类错误
  return err.status === 429 || err.status === 529 || err.status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function consumeStream(
  stream: AsyncIterable<RawStreamEvent>,
  onEvent: (event: AgentEvent) => void,
  markEmitted: () => void,
  signal?: AbortSignal
): Promise<StreamMessageResult> {
  const blocks: ContentBlock[] = [];
  // Anthropic 标准流用递增 index 标识 block；xAI 兼容端点实测有两个差异：
  // content_block_delta 不带 index，且各 content_block_start 会重复 index:0。
  // 协议本身仍保证 start → deltas → stop 串行，因此按当前活动 block 聚合最稳妥，
  // 同时完全兼容标准 Anthropic 流，不依赖供应商的 index 实现细节。
  let activeBlock:
    | { type: "text"; block: TextBlock }
    | { type: "thinking" }
    | { type: "tool_use"; block: Extract<ContentBlock, { type: "tool_use" }>; json: string }
    | undefined;
  let stopReason: StopReason = null;
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let sawUsage = false;
  const startedAt = Date.now();
  let firstOutputAt: number | undefined;

  for await (const event of stream) {
    if (signal?.aborted) throw new ApiError("请求已被中止");
    switch (event.type) {
      case "message_start": {
        const raw = event.message?.usage;
        if (raw) {
          sawUsage = true;
          usage.inputTokens = raw.input_tokens ?? 0;
          usage.cacheReadTokens = raw.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens = raw.cache_creation_input_tokens ?? 0;
          usage.outputTokens = raw.output_tokens ?? 0;
        }
        break;
      }
      case "content_block_start": {
        const cb = event.content_block;
        if (cb.type === "text") {
          const block: TextBlock = { type: "text", text: cb.text ?? "" };
          blocks.push(block);
          activeBlock = { type: "text", block };
        } else if (cb.type === "tool_use") {
          const startInput =
            cb.input && typeof cb.input === "object" && !Array.isArray(cb.input)
              ? (cb.input as Record<string, unknown>)
              : {};
          const block: Extract<ContentBlock, { type: "tool_use" }> = {
            type: "tool_use",
            id: cb.id,
            name: cb.name,
            input: startInput,
          };
          blocks.push(block);
          activeBlock = { type: "tool_use", block, json: "" };
        } else {
          activeBlock = { type: "thinking" };
        }
        break;
      }
      case "content_block_delta": {
        firstOutputAt ??= Date.now();
        if (event.delta.type === "text_delta") {
          if (activeBlock?.type === "text") activeBlock.block.text += event.delta.text;
          markEmitted();
          onEvent({ type: "text_delta", text: event.delta.text });
        } else if (event.delta.type === "thinking_delta") {
          // thinking 内容只渲染：不聚合进返回 content、不入 history（GOAL F19 明确不做）
          markEmitted();
          onEvent({ type: "thinking_delta", text: event.delta.thinking });
        } else if (event.delta.type === "input_json_delta") {
          if (activeBlock?.type === "tool_use") {
            activeBlock.json += event.delta.partial_json;
          }
        }
        break;
      }
      case "content_block_stop": {
        if (activeBlock?.type === "tool_use") {
          const raw = activeBlock.json.trim();
          if (raw.length > 0) {
            try {
              activeBlock.block.input = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              throw new ApiError(`tool_use 输入 JSON 解析失败（工具 ${activeBlock.block.name}）`);
            }
          }
        }
        activeBlock = undefined;
        break;
      }
      case "message_delta": {
        if (event.delta.stop_reason !== undefined) stopReason = event.delta.stop_reason;
        if (event.usage?.output_tokens !== undefined) {
          sawUsage = true;
          usage.outputTokens = event.usage.output_tokens;
        }
        break;
      }
      default:
        break;
    }
  }

  if (sawUsage) {
    onEvent({
      type: "usage",
      usage,
      durationMs: Date.now() - (firstOutputAt ?? startedAt),
    });
  }

  return {
    content: blocks,
    stopReason,
    ...(sawUsage ? { usage } : {}),
  };
}

export function createApiClientFromStreamFn(
  streamFn: StreamFn,
  retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS
): ApiClient {
  return {
    async streamMessage(opts: StreamMessageOptions): Promise<StreamMessageResult> {
      const params: StreamRequestParams = {
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: opts.messages,
        tools: opts.tools,
      };
      // Judge T7 裁决 b：none → 只传 thinking:{type:"disabled"}（实测可真正关闭思考），
      // 不传 reasoning 以避免上游修复 effort 后的歧义；low/high/max → 透传 reasoning.effort
      if (opts.effort === "none") {
        params.thinking = { type: "disabled" };
      } else if (opts.effort) {
        params.reasoning = { effort: opts.effort };
      }
      let attempt = 0;
      for (;;) {
        if (opts.signal?.aborted) throw new ApiError("请求已被中止");
        let emitted = false;
        try {
          const stream = await streamFn(params, opts.signal);
          return await consumeStream(stream, opts.onEvent, () => (emitted = true), opts.signal);
        } catch (err) {
          const apiErr = normalizeError(err);
          if (opts.signal?.aborted) throw apiErr;
          const canRetry = !emitted && isRetryable(apiErr) && attempt < retryDelaysMs.length;
          if (!canRetry) throw apiErr;
          await sleep(retryDelaysMs[attempt]);
          attempt++;
        }
      }
    },
  };
}

export function createApiClient(config: Config): ApiClient {
  const sdk = new Anthropic({
    // authToken 设置时走 Authorization: Bearer（OAuth access token），
    // 此时 apiKey 必须为 null 以免 SDK 同时发 x-api-key
    apiKey: config.authToken ? null : config.apiKey,
    authToken: config.authToken ?? null,
    baseURL: config.baseUrl,
    maxRetries: 0,
  });
  const streamFn: StreamFn = async (params, signal) => {
    const request: Anthropic.MessageCreateParamsStreaming = {
      model: params.model,
      max_tokens: params.max_tokens,
      system: params.system,
      messages: params.messages as unknown as Anthropic.MessageParam[],
      tools: params.tools as unknown as Anthropic.ToolUnion[],
      stream: true,
    };
    // thinking 是 SDK 原生 ThinkingConfigParam，无需 as
    if (params.thinking) request.thinking = params.thinking;
    if (params.reasoning) {
      // reasoning 是 DeepSeek Anthropic 端点扩展字段，SDK 类型不认识，最小范围 as 透传
      (
        request as Anthropic.MessageCreateParamsStreaming & {
          reasoning?: { effort: EffortLevel };
        }
      ).reasoning = params.reasoning;
    }
    const stream = await sdk.messages.create(request, { signal });
    return stream as unknown as AsyncIterable<RawStreamEvent>;
  };
  return createApiClientFromStreamFn(streamFn);
}
