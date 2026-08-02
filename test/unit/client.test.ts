import { describe, expect, it } from "vitest";
import {
  ApiError,
  createApiClientFromStreamFn,
  type RawStreamEvent,
  type StreamMessageOptions,
  type StreamRequestParams,
} from "../../src/api/client.js";
import type { AgentEvent } from "../../src/types/messages.js";

async function* toStream(events: RawStreamEvent[]): AsyncGenerator<RawStreamEvent> {
  for (const event of events) yield event;
}

function baseOptions(onEvent: (e: AgentEvent) => void): StreamMessageOptions {
  return {
    system: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    model: "test-model",
    maxTokens: 1024,
    onEvent,
  };
}

const textAndToolEvents: RawStreamEvent[] = [
  { type: "message_start" },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "，我来读文件" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "tu_1", name: "Read", input: {} },
  },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'path":"a.ts"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
];

describe("api client", () => {
  it("流式解析：即时发 text_delta，tool_use 聚合完整后返回", async () => {
    const client = createApiClientFromStreamFn(async () => toStream(textAndToolEvents), []);
    const events: AgentEvent[] = [];
    const result = await client.streamMessage(baseOptions((e) => events.push(e)));

    expect(events).toEqual([
      { type: "text_delta", text: "你好" },
      { type: "text_delta", text: "，我来读文件" },
    ]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toEqual([
      { type: "text", text: "你好，我来读文件" },
      { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "a.ts" } },
    ]);
  });

  it("兼容 xAI：delta 缺 index 且各 block 重复 index 时仍按流顺序聚合", async () => {
    const xaiEvents: RawStreamEvent[] = [
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "先分析" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "先搜索。" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "Grep", input: {} },
      },
      {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"pattern":"branch"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];
    const client = createApiClientFromStreamFn(async () => toStream(xaiEvents), []);
    const events: AgentEvent[] = [];

    const result = await client.streamMessage(baseOptions((e) => events.push(e)));

    expect(events).toEqual([
      { type: "thinking_delta", text: "先分析" },
      { type: "text_delta", text: "先搜索。" },
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "先搜索。" },
      { type: "tool_use", id: "call_1", name: "Grep", input: { pattern: "branch" } },
    ]);
  });

  it("429 重试后成功", async () => {
    let calls = 0;
    const client = createApiClientFromStreamFn(async () => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }
      return toStream(textAndToolEvents);
    }, [0, 0, 0]);

    const result = await client.streamMessage(baseOptions(() => {}));
    expect(calls).toBe(2);
    expect(result.stopReason).toBe("tool_use");
  });

  it("持续失败：初次 + 3 次重试后抛 ApiError", async () => {
    let calls = 0;
    const client = createApiClientFromStreamFn(async () => {
      calls++;
      throw Object.assign(new Error("server exploded"), { status: 500 });
    }, [0, 0, 0]);

    const err = await client.streamMessage(baseOptions(() => {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toContain("server exploded");
    expect(calls).toBe(4);
  });

  it("不可重试错误（400）立即抛出", async () => {
    let calls = 0;
    const client = createApiClientFromStreamFn(async () => {
      calls++;
      throw Object.assign(new Error("bad request"), { status: 400 });
    }, [0, 0, 0]);

    const err = await client.streamMessage(baseOptions(() => {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect(calls).toBe(1);
  });

  it("effort 原样透传给 streamFn（线格式映射由各 apiFormat 实现负责）", async () => {
    const captured: StreamRequestParams[] = [];
    const client = createApiClientFromStreamFn(async (params) => {
      captured.push(params);
      return toStream(textAndToolEvents);
    }, []);

    for (const level of ["none", "low", "high", "max"] as const) {
      await client.streamMessage({ ...baseOptions(() => {}), effort: level });
    }
    expect(captured.map((p) => p.effort)).toEqual(["none", "low", "high", "max"]);

    await client.streamMessage(baseOptions(() => {}));
    expect(captured[4]).not.toHaveProperty("effort");
  });

  it("thinking_delta 事件即时发出，thinking 内容不进返回 content", async () => {
    const thinkingEvents: RawStreamEvent[] = [
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先比较" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "小数位" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "9.8" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ];
    const client = createApiClientFromStreamFn(async () => toStream(thinkingEvents), []);
    const events: AgentEvent[] = [];
    const result = await client.streamMessage(baseOptions((e) => events.push(e)));

    expect(events).toEqual([
      { type: "thinking_delta", text: "先比较" },
      { type: "thinking_delta", text: "小数位" },
      { type: "text_delta", text: "9.8" },
    ]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toEqual([{ type: "text", text: "9.8" }]);
  });

  it("已发 thinking_delta 后可重试错误不再重试（与 text_delta 同语义）", async () => {
    let calls = 0;
    async function* thinkingThenFail(): AsyncGenerator<RawStreamEvent> {
      yield { type: "content_block_start", index: 0, content_block: { type: "thinking" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想…" } };
      throw Object.assign(new Error("stream broke"), { status: 500 });
    }
    const client = createApiClientFromStreamFn(async () => {
      calls++;
      return thinkingThenFail();
    }, [0, 0, 0]);

    const err = await client.streamMessage(baseOptions(() => {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });

  it("AbortSignal 中止流式读取", async () => {
    const controller = new AbortController();
    async function* endless(): AsyncGenerator<RawStreamEvent> {
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } };
      controller.abort();
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "b" } };
      yield { type: "message_stop" };
    }
    const client = createApiClientFromStreamFn(async () => endless(), []);
    const events: AgentEvent[] = [];
    const opts = { ...baseOptions((e) => events.push(e)), signal: controller.signal };

    await expect(client.streamMessage(opts)).rejects.toBeInstanceOf(ApiError);
    expect(events).toEqual([{ type: "text_delta", text: "a" }]);
  });
});

describe("usage 透传", () => {
  const eventsWithUsage: RawStreamEvent[] = [
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 30,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "答复" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 45 },
    },
    { type: "message_stop" },
  ];

  it("采集 message_start/message_delta 的 usage，流末发 usage 事件并随结果返回", async () => {
    const client = createApiClientFromStreamFn(async () => toStream(eventsWithUsage), []);
    const events: AgentEvent[] = [];
    const result = await client.streamMessage(baseOptions((e) => events.push(e)));

    const expected = {
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 900,
      cacheWriteTokens: 30,
    };
    expect(result.usage).toEqual(expected);

    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents).toHaveLength(1);
    const ev = usageEvents[0] as Extract<AgentEvent, { type: "usage" }>;
    expect(ev.usage).toEqual(expected);
    expect(ev.durationMs).toBeGreaterThanOrEqual(0);
    // usage 事件在文本增量之后（流结束时发出）
    expect(events[events.length - 1].type).toBe("usage");
  });

  it("端点未回报 usage 时不发 usage 事件、结果不带 usage 字段", async () => {
    const client = createApiClientFromStreamFn(async () => toStream(textAndToolEvents), []);
    const events: AgentEvent[] = [];
    const result = await client.streamMessage(baseOptions((e) => events.push(e)));
    expect(result.usage).toBeUndefined();
    expect(events.some((e) => e.type === "usage")).toBe(false);
  });
});
