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
      index: number;
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
  const jsonAcc = new Map<number, string>();
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
          blocks[event.index] = { type: "text", text: cb.text ?? "" };
        } else if (cb.type === "tool_use") {
          blocks[event.index] = { type: "tool_use", id: cb.id, name: cb.name, input: {} };
          jsonAcc.set(event.index, "");
        }
        break;
      }
      case "content_block_delta": {
        firstOutputAt ??= Date.now();
        if (event.delta.type === "text_delta") {
          const block = blocks[event.index] as TextBlock | undefined;
          if (block?.type === "text") block.text += event.delta.text;
          markEmitted();
          onEvent({ type: "text_delta", text: event.delta.text });
        } else if (event.delta.type === "thinking_delta") {
          // thinking 内容只渲染：不聚合进返回 content、不入 history（GOAL F19 明确不做）
          markEmitted();
          onEvent({ type: "thinking_delta", text: event.delta.thinking });
        } else if (event.delta.type === "input_json_delta") {
          jsonAcc.set(event.index, (jsonAcc.get(event.index) ?? "") + event.delta.partial_json);
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks[event.index];
        if (block?.type === "tool_use") {
          const raw = (jsonAcc.get(event.index) ?? "").trim();
          if (raw.length > 0) {
            try {
              block.input = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              throw new ApiError(`tool_use 输入 JSON 解析失败（工具 ${block.name}）`);
            }
          }
        }
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
    content: blocks.filter((b): b is ContentBlock => b !== undefined),
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
    apiKey: config.apiKey,
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
