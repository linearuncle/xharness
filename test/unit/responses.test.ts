import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config, EffortLevel } from "../../src/config.js";
import {
  buildInput,
  buildRequestBody,
  createResponsesStreamFn,
  responsesUrl,
} from "../../src/api/responses.js";
import {
  ApiError,
  createApiClient,
  createApiClientFromStreamFn,
  type RawStreamEvent,
  type StreamRequestParams,
} from "../../src/api/client.js";
import type { AgentEvent, Message } from "../../src/types/messages.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: "test-key",
    baseUrl: "https://api.x.ai",
    model: "grok-test",
    contextWindow: 256_000,
    ...overrides,
  };
}

function params(effort?: EffortLevel): StreamRequestParams {
  return {
    model: "grok-test",
    max_tokens: 1024,
    system: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      {
        name: "Read",
        description: "读文件",
        input_schema: { type: "object", properties: { file_path: { type: "string" } } },
      },
    ],
    ...(effort ? { effort } : {}),
  };
}

function sseResponse(...chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const MINIMAL_SSE = `data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}

`;

/** 完整回合 fixture：reasoning → 文本 → function_call → completed（含 cached usage） */
const FULL_SSE = `data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}

data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"r1"}}

data: {"type":"response.reasoning_text.delta","item_id":"r1","delta":"想一下"}

data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"r1"}}

data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"m1","role":"assistant"}}

data: {"type":"response.content_part.added","item_id":"m1","part":{"type":"output_text","text":""}}

data: {"type":"response.output_text.delta","item_id":"m1","delta":"你好"}

data: {"type":"response.output_text.delta","item_id":"m1","delta":"，世界"}

data: {"type":"response.content_part.done","item_id":"m1","part":{"type":"output_text","text":"你好，世界"}}

data: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"m1"}}

data: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_1","call_id":"call_abc","name":"Read","arguments":""}}

data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"file_"}

data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"path\\":\\"a.ts\\"}"}

data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"file_path\\":\\"a.ts\\"}"}

data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_1","call_id":"call_abc","name":"Read","arguments":"{\\"file_path\\":\\"a.ts\\"}"}}

data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"reasoning"},{"type":"message"},{"type":"function_call"}],"usage":{"input_tokens":1000,"output_tokens":45,"total_tokens":1045,"input_tokens_details":{"cached_tokens":300}}}}

`;

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function stubFetch(respond: (callIndex: number) => Response): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: init?.headers as Record<string, string>,
      });
      return respond(calls.length - 1);
    })
  );
  return calls;
}

const okOnce = () => sseResponse(MINIMAL_SSE);

async function drain(stream: AsyncIterable<RawStreamEvent>): Promise<RawStreamEvent[]> {
  const events: RawStreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

afterEach(() => vi.unstubAllGlobals());

describe("responsesUrl", () => {
  it("host 根路径拼 /v1/responses；/v1 结尾不双拼；尾斜杠归一", () => {
    expect(responsesUrl("https://api.x.ai")).toBe("https://api.x.ai/v1/responses");
    expect(responsesUrl("https://api.x.ai/")).toBe("https://api.x.ai/v1/responses");
    expect(responsesUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/responses"
    );
  });
});

describe("buildInput：内部 Message[] → Responses input", () => {
  it("text/tool_use/tool_result/image 全表转换，块顺序平铺", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "读 a.ts" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "好的" },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "文件内容", is_error: true },
        ],
      },
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "Qk9EWQ==" } },
          { type: "text", text: "看图" },
        ],
      },
    ] as unknown as Message[];

    expect(buildInput(messages)).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "读 a.ts" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "好的" }],
      },
      {
        type: "function_call",
        call_id: "tu_1",
        name: "Read",
        arguments: '{"file_path":"a.ts"}',
      },
      { type: "function_call_output", call_id: "tu_1", output: "文件内容" },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,Qk9EWQ==" },
          { type: "input_text", text: "看图" },
        ],
      },
    ]);
  });
});

describe("buildRequestBody", () => {
  it("instructions/store:false/max_output_tokens/tools 映射；携带 reasoning", () => {
    const body = buildRequestBody(params("high"), "high");
    expect(body).toMatchObject({
      model: "grok-test",
      instructions: "sys",
      max_output_tokens: 1024,
      stream: true,
      store: false,
      reasoning: { effort: "high" },
    });
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "Read",
        description: "读文件",
        parameters: { type: "object", properties: { file_path: { type: "string" } } },
      },
    ]);
  });

  it("tools 为空时省略 tools 字段；effort 缺省时省略 reasoning", () => {
    const body = buildRequestBody({ ...params(), tools: [] }, undefined);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("reasoning");
  });
});

describe("responses streamFn：SSE → RawStreamEvent", () => {
  it("完整回合：reasoning/text/function_call/completed 全序列翻译，usage 拆分 cached", async () => {
    stubFetch(() => sseResponse(FULL_SSE));
    const events = await drain(await createResponsesStreamFn(config())(params("high")));
    expect(events).toEqual([
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想一下" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "，世界" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_abc", name: "Read" },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'path":"a.ts"}' } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 700,
            output_tokens: 45,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 0,
          },
        },
      },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]);
  });

  it("reasoning_summary_text.delta 同样映射为 thinking_delta", async () => {
    stubFetch(() =>
      sseResponse(
        `data: {"type":"response.reasoning_summary_text.delta","delta":"摘要思考"}\n\n` +
          `data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n`
      )
    );
    const events = await drain(await createResponsesStreamFn(config())(params()));
    expect(events[0]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "摘要思考" },
    });
  });

  it("健壮性：CRLF、空 data 帧、事件跨 chunk、末尾无空行冲刷", async () => {
    stubFetch(() =>
      sseResponse(
        'data: {"type":"response.output_item.added","item":{"type":"message"}}\r\n\r\ndata: \n\n',
        'data: {"type":"response.output_text.del',
        'ta","delta":"嗨"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":2}}}'
      )
    );
    const events = await drain(await createResponsesStreamFn(config())(params()));
    expect(events).toEqual([
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "嗨" } },
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 5,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ]);
  });

  it("incomplete + max_output_tokens → stop_reason max_tokens", async () => {
    stubFetch(() =>
      sseResponse(
        `data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[],"usage":{"input_tokens":3,"output_tokens":1024}}}\n\n`
      )
    );
    const events = await drain(await createResponsesStreamFn(config())(params()));
    expect(events[events.length - 1]).toEqual({
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
    });
  });
});

describe("responses streamFn：请求与鉴权", () => {
  it("effort 映射：low→low；high/max→high；none/未设省略 reasoning", async () => {
    const calls = stubFetch(okOnce);
    const streamFn = createResponsesStreamFn(config());
    await drain(await streamFn(params("low")));
    await drain(await streamFn(params("high")));
    await drain(await streamFn(params("max")));
    await drain(await streamFn(params("none")));
    await drain(await streamFn(params()));
    expect(calls[0].body.reasoning).toEqual({ effort: "low" });
    expect(calls[1].body.reasoning).toEqual({ effort: "high" });
    expect(calls[2].body.reasoning).toEqual({ effort: "high" });
    expect(calls[3]).not.toHaveProperty("reasoning");
    expect(calls[4]).not.toHaveProperty("reasoning");
  });

  it("authToken 优先于 apiKey 作为 Bearer", async () => {
    const calls = stubFetch(okOnce);
    await drain(
      await createResponsesStreamFn(config({ authToken: "oauth-token" }))(params())
    );
    expect(calls[0].headers.authorization).toBe("Bearer oauth-token");
    await drain(await createResponsesStreamFn(config())(params()));
    expect(calls[1].headers.authorization).toBe("Bearer test-key");
  });
});

describe("responses streamFn：错误与降级", () => {
  it("reasoning 400 自动降级：去 reasoning 重试一次后成功", async () => {
    const calls = stubFetch((i) =>
      i === 0
        ? new Response(
            JSON.stringify({
              error: { message: "grok-4-1-fast does not support parameter reasoningEffort" },
            }),
            { status: 400 }
          )
        : sseResponse(MINIMAL_SSE)
    );
    const events = await drain(await createResponsesStreamFn(config())(params("high")));
    expect(calls).toHaveLength(2);
    expect(calls[0].body.reasoning).toEqual({ effort: "high" });
    expect(calls[1].body).not.toHaveProperty("reasoning");
    expect(events[events.length - 1]).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    });
  });

  it("非 reasoning 类 400 不降级：原样抛 ApiError(status 400)", async () => {
    const calls = stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "invalid model id" } }), {
          status: 400,
        })
    );
    const err = await createResponsesStreamFn(config())(params("high"))
      .then((s) => drain(s))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toContain("invalid model id");
    expect(calls).toHaveLength(1);
  });

  it("effort 未携带时 reasoning 400 不降级", async () => {
    const calls = stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "reasoning not allowed here" } }),
          { status: 400 }
        )
    );
    const err = await createResponsesStreamFn(config())(params())
      .then((s) => drain(s))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it("500 → ApiError(status 500)，含端点 error.message", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "server exploded" } }), {
          status: 500,
        })
    );
    const err = await createResponsesStreamFn(config())(params())
      .then((s) => drain(s))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toContain("server exploded");
  });

  it("response.failed 帧 → 抛 ApiError", async () => {
    stubFetch(() =>
      sseResponse(
        `data: {"type":"response.failed","response":{"status":"failed","error":{"message":"模型内部错误"}}}\n\n`
      )
    );
    const err = await createResponsesStreamFn(config())(params())
      .then((s) => drain(s))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("模型内部错误");
  });

  it("error 帧 → 抛 ApiError", async () => {
    stubFetch(() => sseResponse(`data: {"type":"error","message":"流炸了"}\n\n`));
    const err = await createResponsesStreamFn(config())(params())
      .then((s) => drain(s))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("流炸了");
  });
});

describe("经共享聚合层集成", () => {
  it("createApiClientFromStreamFn + responses streamFn：content/usage/事件全对", async () => {
    stubFetch(() => sseResponse(FULL_SSE));
    const client = createApiClientFromStreamFn(createResponsesStreamFn(config()), []);
    const events: AgentEvent[] = [];
    const result = await client.streamMessage({
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: params().tools,
      model: "grok-test",
      maxTokens: 1024,
      effort: "high",
      onEvent: (e) => events.push(e),
    });

    expect(result.content).toEqual([
      { type: "text", text: "你好，世界" },
      { type: "tool_use", id: "call_abc", name: "Read", input: { file_path: "a.ts" } },
    ]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.usage).toEqual({
      inputTokens: 700,
      outputTokens: 45,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
    });
    expect(events.filter((e) => e.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "想一下" },
    ]);
    expect(events[events.length - 1].type).toBe("usage");
  });

  it("createApiClient 按 apiFormat=openai-responses 分发到 /v1/responses", async () => {
    const calls = stubFetch(okOnce);
    const client = createApiClient(config({ apiFormat: "openai-responses" }));
    await client.streamMessage({
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      model: "grok-test",
      maxTokens: 1024,
      onEvent: () => {},
    });
    expect(calls[0].url).toBe("https://api.x.ai/v1/responses");
  });
});
