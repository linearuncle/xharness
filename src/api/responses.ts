/**
 * OpenAI Response API 格式的 streamFn（`POST {base}/v1/responses`，零依赖 fetch+SSE）。
 *
 * 定位：把 Response API 的线协议翻译成 client.ts 的 RawStreamEvent（Anthropic 形状），
 * 从而 100% 复用共享的重试与 consumeStream 聚合逻辑——loop/compact/render 零感知。
 *
 * 要点：
 * - 内部领域模型（Message[]/ContentBlock）保持不变，是本模块的输入；图片块由 GUI
 *   附件注入（结构同 Anthropic image 块），转换为 input_image data URL；
 * - tool_use/tool_result 配对不变量天然映射 function_call/function_call_output
 *   （call_id 沿用 tool_use.id）；Response API 的 function_call_output 无 is_error
 *   字段，错误文本本身自解释，直接透传 output 字符串；
 * - store:false 无状态模式：harness 每回合重放全量历史，不用 previous_response_id；
 * - usage 分解对齐引擎计费的 Anthropic 语义（input 不含缓存）：Response API 的
 *   input_tokens 包含 cached_tokens，需拆分，否则缓存命中部分被按全价重复计费；
 * - reasoning 仅 low/high 两档（xAI）：none/未设省略 reasoning，max 归并 high；
 *   部分模型（如 grok-4-1-fast）不支持 reasoning 参数会 400，此时自动去 reasoning
 *   重试一次（尚未产出任何流事件，安全）。注意：grok 的推理 token 计入
 *   max_output_tokens，高推理档 8192 上限可能截断（stop_reason=max_tokens 已有处理）。
 */
import type { Config, EffortLevel } from "../config.js";
import type { ContentBlock, Message, StopReason } from "../types/messages.js";
import {
  ApiError,
  type RawStreamEvent,
  type RawUsage,
  type StreamFn,
} from "./client.js";

/** GUI 附件注入的图片块（不属于 ContentBlock 联合，结构同 Anthropic image 块） */
interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

/** SSE 帧 JSON 负载（按需声明，未知字段忽略） */
interface ResponsesSseEvent {
  type?: string;
  item?: { type?: string; call_id?: string; name?: string };
  delta?: string;
  message?: string;
  response?: {
    status?: string;
    incomplete_details?: { reason?: string };
    output?: Array<{ type?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
    error?: { message?: string };
  };
}

/** baseUrl 规范化：以 /v1 结尾直接拼 /responses，否则拼 /v1/responses */
export function responsesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/responses` : `${base}/v1/responses`;
}

/** xAI Responses 仅 low/high 两档：none/未设省略 reasoning，max 归并 high */
function mapEffort(effort?: EffortLevel): "low" | "high" | undefined {
  if (effort === "low") return "low";
  if (effort === "high" || effort === "max") return "high";
  return undefined;
}

type InputItem = Record<string, unknown>;

/** 内部 Message[] → Responses input 项：块顺序平铺，文本/图片聚成 message 项 */
export function buildInput(messages: Message[]): InputItem[] {
  const items: InputItem[] = [];
  for (const msg of messages) {
    const textType = msg.role === "assistant" ? "output_text" : "input_text";
    let parts: Array<Record<string, unknown>> = [];
    const flush = () => {
      if (parts.length > 0) {
        items.push({ type: "message", role: msg.role, content: parts });
        parts = [];
      }
    };
    for (const block of msg.content as Array<ContentBlock | ImageBlock>) {
      if (block.type === "text") {
        parts.push({ type: textType, text: block.text });
      } else if (block.type === "image") {
        parts.push({
          type: "input_image",
          image_url: `data:${block.source.media_type};base64,${block.source.data}`,
        });
      } else if (block.type === "tool_use") {
        flush();
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        flush();
        items.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: block.content,
        });
      }
    }
    flush();
  }
  return items;
}

/** 请求体构建；effort 为 undefined 时不携带 reasoning 字段 */
export function buildRequestBody(
  params: Parameters<StreamFn>[0],
  effort: "low" | "high" | undefined
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    instructions: params.system,
    input: buildInput(params.messages),
    max_output_tokens: params.max_tokens,
    stream: true,
    store: false,
  };
  if (params.tools.length > 0) {
    body.tools = params.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));
  }
  if (effort) body.reasoning = { effort };
  return body;
}

function toApiError(status: number, text: string): ApiError {
  let message = text.slice(0, 500);
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
    message = parsed.error?.message ?? parsed.message ?? message;
  } catch {
    /* 非 JSON 报错原文透传 */
  }
  return new ApiError(`Response API 请求失败（HTTP ${status}）：${message}`, status);
}

/** SSE 帧迭代：按空行切事件（兼容 CRLF），拼接多行 data:，跳过空帧与 [DONE] */
async function* iterateSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<ResponsesSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const sep = /\r?\n\r?\n/;
  const drain = function* (chunk: string): Generator<ResponsesSseEvent> {
    let m: RegExpExecArray | null;
    while ((m = sep.exec(chunk)) !== null) {
      const rawEvent = chunk.slice(0, m.index);
      chunk = chunk.slice(m.index + m[0].length);
      const dataLines: string[] = [];
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      const data = dataLines.join("\n").trim();
      if (!data || data === "[DONE]") continue;
      yield JSON.parse(data) as ResponsesSseEvent;
    }
    buffer = chunk;
  };
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel();
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      yield* drain(buffer + decoder.decode(value, { stream: true }));
    }
    // 上游可能不以空行收尾：冲刷残余 buffer 作为最后一帧
    if (buffer.trim()) yield* drain(buffer + "\n\n");
  } finally {
    reader.releaseLock();
  }
}

/** Responses SSE 事件 → RawStreamEvent（可能产出 0..n 个；错误帧直接抛 ApiError） */
function translateEvent(ev: ResponsesSseEvent): RawStreamEvent[] {
  switch (ev.type) {
    case "response.output_item.added": {
      const item = ev.item;
      if (item?.type === "message") {
        return [
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
        ];
      }
      if (item?.type === "function_call") {
        return [
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: item.call_id ?? "",
              name: item.name ?? "",
            },
          },
        ];
      }
      if (item?.type === "reasoning") {
        return [
          { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        ];
      }
      return [];
    }
    case "response.output_text.delta":
      return [
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ev.delta ?? "" } },
      ];
    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta":
      return [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: ev.delta ?? "" },
        },
      ];
    case "response.function_call_arguments.delta":
      return [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: ev.delta ?? "" },
        },
      ];
    case "response.content_part.done":
    case "response.output_item.done":
      return [{ type: "content_block_stop", index: 0 }];
    case "response.completed":
    case "response.incomplete": {
      const r = ev.response;
      const stopReason: StopReason =
        r?.status === "incomplete" &&
        r.incomplete_details?.reason === "max_output_tokens"
          ? "max_tokens"
          : r?.output?.some((o) => o.type === "function_call")
            ? "tool_use"
            : "end_turn";
      const out: RawStreamEvent[] = [];
      const u = r?.usage;
      if (u) {
        // Response API 的 input_tokens 含 cached_tokens；拆分为 Anthropic 语义（input 不含缓存）
        const cached = u.input_tokens_details?.cached_tokens ?? 0;
        const usage: RawUsage = {
          input_tokens: (u.input_tokens ?? 0) - cached,
          output_tokens: u.output_tokens ?? 0,
          cache_read_input_tokens: cached,
          cache_creation_input_tokens: 0,
        };
        out.push({ type: "message_start", message: { usage } });
      }
      out.push({ type: "message_delta", delta: { stop_reason: stopReason } });
      return out;
    }
    case "response.failed":
      throw new ApiError(
        `Response API 响应失败：${ev.response?.error?.message ?? "未知错误"}`
      );
    case "error":
      throw new ApiError(`Response API 流错误：${ev.message ?? "未知错误"}`);
    default:
      return [];
  }
}

async function* translateStream(
  events: AsyncGenerator<ResponsesSseEvent>
): AsyncGenerator<RawStreamEvent> {
  for await (const ev of events) {
    yield* translateEvent(ev);
  }
}

export function createResponsesStreamFn(config: Config): StreamFn {
  const url = responsesUrl(config.baseUrl);
  const token = config.authToken || config.apiKey;
  const post = (body: unknown, signal?: AbortSignal) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal,
    });

  return async (params, signal) => {
    const effort = mapEffort(params.effort);
    let response = await post(buildRequestBody(params, effort), signal);
    if (!response.ok) {
      const text = await response.text();
      // 部分模型（如 grok-4-1-fast）不支持 reasoning 参数：400 且报文提及 reasoning
      // 时自动去 reasoning 重试一次（尚未产出任何流事件，安全）
      if (response.status === 400 && effort && /reasoning/i.test(text)) {
        response = await post(buildRequestBody(params, undefined), signal);
        if (!response.ok) throw toApiError(response.status, await response.text());
      } else {
        throw toApiError(response.status, text);
      }
    }
    if (!response.body) throw new ApiError("Response API 响应缺少 body");
    return translateStream(iterateSse(response.body, signal));
  };
}
