import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config, EffortLevel } from "../../src/config.js";
import { createAnthropicStreamFn } from "../../src/api/anthropic.js";
import { createApiClient, type StreamRequestParams } from "../../src/api/client.js";

/** 最小合法 Anthropic SSE 流（SDK 能走完整个流即可） */
const ANTHROPIC_SSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","usage":{"input_tokens":1,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}

event: message_stop
data: {"type":"message_stop"}

`;

function config(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: "test-key",
    baseUrl: "https://example.com/anthropic",
    model: "test-model",
    contextWindow: 200_000,
    ...overrides,
  };
}

function params(effort?: EffortLevel): StreamRequestParams {
  return {
    model: "test-model",
    max_tokens: 1024,
    system: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    ...(effort ? { effort } : {}),
  };
}

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
  headers: RequestInit["headers"];
}

function stubFetch(): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: init?.headers,
      });
      return new Response(ANTHROPIC_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    })
  );
  return calls;
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    /* 耗尽流 */
  }
}

function header(headers: RequestInit["headers"], name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    return headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  }
  return (headers as Record<string, string>)[name] ?? null;
}

afterEach(() => vi.unstubAllGlobals());

describe("anthropic streamFn：effort 映射（Judge T7 裁决 b）", () => {
  it("effort none → 只传 thinking:{type:\"disabled\"}，不传 reasoning", async () => {
    const calls = stubFetch();
    await drain(await createAnthropicStreamFn(config())(params("none")));
    expect(calls[0].body.thinking).toEqual({ type: "disabled" });
    expect(calls[0].body).not.toHaveProperty("reasoning");
  });

  it("effort low/high/max → 只传 reasoning.effort，不传 thinking", async () => {
    const calls = stubFetch();
    const streamFn = createAnthropicStreamFn(config());
    for (const level of ["low", "high", "max"] as const) {
      await drain(await streamFn(params(level)));
    }
    for (const [i, level] of (["low", "high", "max"] as const).entries()) {
      expect(calls[i].body.reasoning).toEqual({ effort: level });
      expect(calls[i].body).not.toHaveProperty("thinking");
    }
  });

  it("effort 未设置 → reasoning 与 thinking 皆不携带", async () => {
    const calls = stubFetch();
    await drain(await createAnthropicStreamFn(config())(params()));
    expect(calls[0].body).not.toHaveProperty("reasoning");
    expect(calls[0].body).not.toHaveProperty("thinking");
  });
});

describe("anthropic streamFn：鉴权", () => {
  it("authToken 设置时走 Bearer，不发 x-api-key", async () => {
    const calls = stubFetch();
    await drain(
      await createAnthropicStreamFn(config({ authToken: "oauth-token" }))(params())
    );
    expect(header(calls[0].headers, "authorization")).toBe("Bearer oauth-token");
    expect(header(calls[0].headers, "x-api-key")).toBeNull();
  });

  it("无 authToken 时走 x-api-key", async () => {
    const calls = stubFetch();
    await drain(await createAnthropicStreamFn(config())(params()));
    expect(header(calls[0].headers, "x-api-key")).toBe("test-key");
  });
});

describe("createApiClient 分发", () => {
  it("apiFormat 缺省 → anthropic（SDK 拼 /v1/messages）", async () => {
    const calls = stubFetch();
    const client = createApiClient(config());
    await client.streamMessage({
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      model: "test-model",
      maxTokens: 1024,
      onEvent: () => {},
    });
    expect(calls[0].url).toBe("https://example.com/anthropic/v1/messages");
  });
});
