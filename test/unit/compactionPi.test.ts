import { describe, expect, it } from "vitest";
import {
  forceCompact,
  maybeCompact,
  SUMMARY_PREFIX,
  getCompactionStrategy,
  listCompactionStrategies,
  DEFAULT_COMPACTION_STRATEGY_ID,
} from "../../src/agent/compaction/index.js";
import { History } from "../../src/session/history.js";
import type {
  ApiClient,
  StreamMessageOptions,
  StreamMessageResult,
} from "../../src/api/client.js";
import type { Config } from "../../src/config.js";
import type { Message, TextBlock, ToolUseBlock } from "../../src/types/messages.js";

function piConfig(contextWindow: number): Config {
  return {
    apiKey: "key",
    baseUrl: "https://example.test",
    model: "deepseek-v4-pro",
    contextWindow,
    compactionStrategy: "pi",
  };
}

interface FakeClient extends ApiClient {
  calls: StreamMessageOptions[];
}

function fakeClient(summaryText: string): FakeClient {
  const calls: StreamMessageOptions[] = [];
  return {
    calls,
    async streamMessage(opts): Promise<StreamMessageResult> {
      calls.push(opts);
      return {
        content: [{ type: "text", text: summaryText }],
        stopReason: "end_turn",
      };
    },
  };
}

function failingClient(): FakeClient {
  const calls: StreamMessageOptions[] = [];
  return {
    calls,
    async streamMessage(opts): Promise<StreamMessageResult> {
      calls.push(opts);
      throw new Error("模拟 API 故障");
    },
  };
}

function textMessage(
  role: "user" | "assistant",
  text: string,
  padChars = 0
): Message {
  return {
    role,
    content: [{ type: "text", text: text + "x".repeat(padChars) }],
  };
}

/** 每条约 2000+ token（8000 字符 padding），10 条即超过 keepRecentTokens=20000 */
const BIG = 8000;

function requestText(call: StreamMessageOptions): string {
  return (call.messages[0].content[0] as TextBlock).text;
}

function expectAllToolUsesPaired(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const toolUses = messages[i].content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use"
    );
    if (toolUses.length === 0) continue;
    const next = messages[i + 1];
    expect(next, `消息 ${i} 含 tool_use 但没有后续消息`).toBeDefined();
    const resultIds = new Set(
      next.content
        .filter((b) => b.type === "tool_result")
        .map((b) => (b as { tool_use_id: string }).tool_use_id)
    );
    for (const use of toolUses) {
      expect(
        resultIds.has(use.id),
        `tool_use ${use.id} 缺少配对 tool_result`
      ).toBe(true);
    }
  }
}

describe("策略注册表", () => {
  it("列出 classic 与 pi，默认策略为 classic", () => {
    const ids = listCompactionStrategies().map((s) => s.id);
    expect(ids).toContain("classic");
    expect(ids).toContain("pi");
    expect(DEFAULT_COMPACTION_STRATEGY_ID).toBe("classic");
  });

  it("未知/未设 id 回退默认策略，不抛错", () => {
    expect(getCompactionStrategy(undefined).id).toBe("classic");
    expect(getCompactionStrategy("不存在的策略").id).toBe("classic");
    expect(getCompactionStrategy("pi").id).toBe("pi");
  });
});

describe("pi 策略触发条件", () => {
  it("剩余窗口充足时不触发、不调用 API", async () => {
    const history = new History();
    for (let i = 0; i < 6; i++) {
      history.push(textMessage(i % 2 === 0 ? "user" : "assistant", `消息${i}`));
    }
    const client = fakeClient("摘要");
    const result = await maybeCompact({
      history,
      client,
      config: piConfig(1_000_000),
    });
    expect(result.compacted).toBe(false);
    expect(client.calls).toHaveLength(0);
  });

  it("剩余窗口不足 reserveTokens 时自动触发", async () => {
    const history = new History();
    for (let i = 0; i < 20; i++) {
      history.push(
        textMessage(i % 2 === 0 ? "user" : "assistant", `消息${i}`, BIG)
      );
    }
    // 历史约 4 万 token，窗口 3 万 → 剩余不足 16384，触发
    const client = fakeClient("这里是结构化摘要");
    const result = await maybeCompact({
      history,
      client,
      config: piConfig(30_000),
    });
    expect(result.compacted).toBe(true);
    expect(client.calls).toHaveLength(1);
  });
});

describe("pi 策略：token 预算切点", () => {
  it("保留最近约 keepRecentTokens 的消息，旧消息进入摘要", async () => {
    const history = new History();
    for (let i = 0; i < 20; i++) {
      history.push(
        textMessage(i % 2 === 0 ? "user" : "assistant", `消息${i}`, BIG)
      );
    }
    const client = fakeClient("结构化摘要内容");
    const result = await forceCompact({
      history,
      client,
      config: piConfig(1_000_000),
    });
    expect(result.compacted).toBe(true);

    const messages = history.getMessages();
    // 每条约 2014 token：从最新累计 10 条（下标 10..19）达到 2 万预算，切点在 10
    expect(messages).toHaveLength(11);
    const first = messages[0];
    expect(first.role).toBe("user");
    const firstText = (first.content[0] as TextBlock).text;
    expect(firstText.startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(firstText).toContain("结构化摘要内容");
    expect((messages[1].content[0] as TextBlock).text).toContain("消息10");

    // 摘要请求只含旧历史，且是序列化文本形式
    const request = requestText(client.calls[0]);
    expect(request).toContain("消息0");
    expect(request).toContain("消息9");
    expect(request).not.toContain("消息10");
    expect(request).toContain("<conversation>");
  });

  it("切点落在 tool_result 消息上时移到最近合法切点，不拆配对", async () => {
    const history = new History();
    // 旧侧：5 条大文本
    for (let i = 0; i < 5; i++) {
      history.push(
        textMessage(i % 2 === 0 ? "user" : "assistant", `旧消息${i}`, BIG)
      );
    }
    // 回合起点 + 大 tool_use / 大 tool_result / 大 assistant 文本收尾
    history.push(textMessage("user", "执行大任务"));
    history.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "Bash",
          input: { command: "x".repeat(40_000) },
        },
      ],
    });
    history.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "y".repeat(40_000) },
      ],
    });
    history.push(textMessage("assistant", "收尾说明", 44_000));

    const client = fakeClient("摘要");
    const result = await forceCompact({
      history,
      client,
      config: piConfig(1_000_000),
    });
    expect(result.compacted).toBe(true);

    const messages = history.getMessages();
    // 累计到 tool_result（下标 7）超预算，切点后移到合法的 assistant 文本（下标 8）
    for (const m of messages) {
      expectAllToolUsesPaired(messages);
      void m;
    }
    expect(
      messages[1].content.some((b) => b.type === "tool_result")
    ).toBe(false);
  });
});

describe("pi 策略：切分回合（split turn）", () => {
  it("切点在回合中间时生成回合前缀摘要并与历史摘要合并", async () => {
    const history = new History();
    for (let i = 0; i < 4; i++) {
      history.push(textMessage(i % 2 === 0 ? "user" : "assistant", `早期消息${i}`));
    }
    history.push(textMessage("user", "这个回合的原始大任务请求"));
    history.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_big",
          name: "Bash",
          input: { command: "x".repeat(40_000) },
        },
      ],
    });
    history.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_big",
          content: "y".repeat(40_000),
        },
      ],
    });
    history.push(textMessage("assistant", "回合后半段工作", 44_000));

    const client = fakeClient("摘要片段");
    const result = await forceCompact({
      history,
      client,
      config: piConfig(1_000_000),
    });
    expect(result.compacted).toBe(true);

    // 两次 LLM 调用：历史摘要 + 回合前缀摘要
    expect(client.calls).toHaveLength(2);
    expect(requestText(client.calls[0])).toContain("早期消息0");
    const prefixRequest = requestText(client.calls[1]);
    expect(prefixRequest).toContain("原始大任务请求");
    expect(prefixRequest).toContain("原始请求");

    const firstText = (history.getMessages()[0].content[0] as TextBlock).text;
    expect(firstText).toContain("回合上下文");
    expectAllToolUsesPaired(history.getMessages());
  });
});

describe("pi 策略：迭代更新与文件跟踪", () => {
  it("已有摘要时走增量更新，且跨次累积文件清单", async () => {
    const history = new History();
    history.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `${SUMMARY_PREFIX}\n旧摘要内容\n<read-files>\nold.ts\n</read-files>`,
        },
      ],
    });
    // 旧侧：含 Read/Edit 工具调用的配对消息
    history.push({
      role: "assistant",
      content: [
        { type: "text", text: "读改文件" + "x".repeat(BIG) },
        { type: "tool_use", id: "tu_r", name: "Read", input: { file_path: "a.ts" } },
        { type: "tool_use", id: "tu_e", name: "Edit", input: { file_path: "b.ts" } },
      ],
    });
    history.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_r", content: "内容A" },
        { type: "tool_result", tool_use_id: "tu_e", content: "已修改" },
      ],
    });
    // 新侧：10 条大消息（约 2 万 token），切点落在其起点
    for (let i = 0; i < 10; i++) {
      history.push(
        textMessage(i % 2 === 0 ? "user" : "assistant", `新消息${i}`, BIG)
      );
    }

    const client = fakeClient("更新后的摘要");
    const result = await forceCompact({
      history,
      client,
      config: piConfig(1_000_000),
    });
    expect(result.compacted).toBe(true);
    expect(client.calls).toHaveLength(1);

    // 增量更新：请求携带上次摘要
    const request = requestText(client.calls[0]);
    expect(request).toContain("<previous-summary>");
    expect(request).toContain("旧摘要内容");
    expect(request).toContain("保留已有摘要中的全部信息");

    // 文件清单：上次的 old.ts 与本次 Read 的 a.ts 累积；Edit 的 b.ts 进 modified
    const firstText = (history.getMessages()[0].content[0] as TextBlock).text;
    expect(firstText).toContain("更新后的摘要");
    expect(firstText).toMatch(/<read-files>[\s\S]*a\.ts[\s\S]*<\/read-files>/);
    expect(firstText).toMatch(/<read-files>[\s\S]*old\.ts[\s\S]*<\/read-files>/);
    expect(firstText).toMatch(
      /<modified-files>[\s\S]*b\.ts[\s\S]*<\/modified-files>/
    );
    expectAllToolUsesPaired(history.getMessages());
  });
});

describe("pi 策略：异常路径", () => {
  it("API 失败时保留原历史并返回 warning", async () => {
    const history = new History();
    for (let i = 0; i < 20; i++) {
      history.push(
        textMessage(i % 2 === 0 ? "user" : "assistant", `消息${i}`, BIG)
      );
    }
    const before = history.getMessages();
    const client = failingClient();
    const result = await forceCompact({
      history,
      client,
      config: piConfig(1_000_000),
    });
    expect(result.compacted).toBe(false);
    expect(result.warning).toContain("模拟 API 故障");
    expect(history.getMessages()).toEqual(before);
  });

  it("历史太短（全部在保留预算内）时友好返回、不调用 API", async () => {
    const history = new History();
    for (let i = 0; i < 6; i++) {
      history.push(textMessage(i % 2 === 0 ? "user" : "assistant", `消息${i}`));
    }
    const before = history.getMessages();
    const client = fakeClient("摘要");
    const result = await forceCompact({
      history,
      client,
      config: piConfig(1_000_000),
    });
    expect(result.compacted).toBe(false);
    expect(result.warning).toContain("太短");
    expect(client.calls).toHaveLength(0);
    expect(history.getMessages()).toEqual(before);
  });
});
