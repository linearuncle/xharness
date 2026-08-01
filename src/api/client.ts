import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type {
  AgentEvent,
  ContentBlock,
  Message,
  StopReason,
  TextBlock,
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
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

export interface StreamMessageResult {
  content: ContentBlock[];
  stopReason: StopReason;
}

export interface ApiClient {
  streamMessage(opts: StreamMessageOptions): Promise<StreamMessageResult>;
}

export type RawStreamEvent =
  | { type: "message_start"; message?: unknown }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "text"; text?: string }
        | { type: "tool_use"; id: string; name: string; input?: unknown };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: StopReason } }
  | { type: "message_stop" };

export interface StreamRequestParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: Message[];
  tools: ApiToolDefinition[];
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

  for await (const event of stream) {
    if (signal?.aborted) throw new ApiError("请求已被中止");
    switch (event.type) {
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
        if (event.delta.type === "text_delta") {
          const block = blocks[event.index] as TextBlock | undefined;
          if (block?.type === "text") block.text += event.delta.text;
          markEmitted();
          onEvent({ type: "text_delta", text: event.delta.text });
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
        break;
      }
      default:
        break;
    }
  }

  return { content: blocks.filter((b): b is ContentBlock => b !== undefined), stopReason };
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
    const stream = await sdk.messages.create(
      {
        model: params.model,
        max_tokens: params.max_tokens,
        system: params.system,
        messages: params.messages as unknown as Anthropic.MessageParam[],
        tools: params.tools as unknown as Anthropic.ToolUnion[],
        stream: true,
      },
      { signal }
    );
    return stream as unknown as AsyncIterable<RawStreamEvent>;
  };
  return createApiClientFromStreamFn(streamFn);
}
