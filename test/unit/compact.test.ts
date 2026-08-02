import { describe, expect, it } from "vitest";
import {
  forceCompact,
  maybeCompact,
  KEEP_RECENT_MESSAGES,
  SUMMARY_PREFIX,
} from "../../src/agent/compaction/index.js";
import { History } from "../../src/session/history.js";
import type {
  ApiClient,
  StreamMessageOptions,
  StreamMessageResult,
} from "../../src/api/client.js";
import type { Config } from "../../src/config.js";
import type { Message, TextBlock, ToolUseBlock } from "../../src/types/messages.js";
import type { TodoStore } from "../../src/tools/todoWrite.js";

function fakeConfig(contextWindow: number): Config {
  return {
    apiKey: "key",
    baseUrl: "https://example.test",
    model: "deepseek-v4-pro",
    contextWindow,
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

function textMessage(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

/** 构造 count 条交替 user/assistant 文本消息的历史 */
function buildHistory(count: number, padding = ""): History {
  const history = new History();
  for (let i = 0; i < count; i++) {
    history.push(
      textMessage(i % 2 === 0 ? "user" : "assistant", `消息${i}${padding}`)
    );
  }
  return history;
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
      expect(resultIds.has(use.id), `tool_use ${use.id} 缺少配对 tool_result`).toBe(
        true
      );
    }
  }
}

describe("maybeCompact", () => {
  it("低于阈值时无操作、不调用 API", async () => {
    const history = buildHistory(20);
    const before = history.getMessages();
    const client = fakeClient("摘要");
    const result = await maybeCompact({
      history,
      client,
      config: fakeConfig(1_000_000),
    });
    expect(result.compacted).toBe(false);
    expect(result.warning).toBeUndefined();
    expect(client.calls).toHaveLength(0);
    expect(history.getMessages()).toEqual(before);
  });

  it("超过阈值时压缩：摘要 user 消息开头 + 保留最近 N 条，token 显著下降", async () => {
    const padding = "x".repeat(500);
    const history = buildHistory(30, padding);
    const before = history.estimateTokens();
    const client = fakeClient("这里是压缩摘要");
    const result = await maybeCompact({
      history,
      client,
      config: fakeConfig(100), // 阈值 80 token，必然触发
    });

    expect(result.compacted).toBe(true);
    const messages = history.getMessages();
    expect(messages).toHaveLength(KEEP_RECENT_MESSAGES + 1);

    const first = messages[0];
    expect(first.role).toBe("user");
    const firstText = (first.content[0] as TextBlock).text;
    expect(firstText.startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(firstText).toContain("这里是压缩摘要");

    // 保留窗口是原历史的最后 N 条
    expect((messages[1].content[0] as TextBlock).text).toContain("消息20");
    expect(
      (messages[KEEP_RECENT_MESSAGES].content[0] as TextBlock).text
    ).toContain("消息29");

    expect(history.estimateTokens()).toBeLessThan(before / 2);
    expect(result.beforeTokens).toBe(before);
    expect(result.afterTokens).toBe(history.estimateTokens());
  });

  it("压缩提示词要求保留决策、任务状态与文件清单，且只含旧历史", async () => {
    const history = buildHistory(20, "x".repeat(200));
    const client = fakeClient("摘要");
    await maybeCompact({ history, client, config: fakeConfig(100) });

    expect(client.calls).toHaveLength(1);
    const request = (client.calls[0].messages[0].content[0] as TextBlock).text;
    expect(request).toContain("决策");
    expect(request).toContain("AskUserQuestion");
    expect(request).toContain("任务状态");
    expect(request).toContain("文件清单");
    expect(request).toContain("消息0");
    expect(request).toContain("消息9");
    expect(request).not.toContain("消息10");
  });

  it("API 失败时保留原历史并返回 warning", async () => {
    const history = buildHistory(20, "x".repeat(200));
    const before = history.getMessages();
    const client = failingClient();
    const result = await maybeCompact({
      history,
      client,
      config: fakeConfig(100),
    });
    expect(result.compacted).toBe(false);
    expect(result.warning).toContain("模拟 API 故障");
    expect(history.getMessages()).toEqual(before);
    expect(client.calls).toHaveLength(1); // 本回合不自动重试
  });
});

describe("配对安全切点", () => {
  it("N 边界落在 tool_use/tool_result 中间时向旧侧扩窗，不拆配对", async () => {
    const history = new History();
    // 前置旧历史（凑数）
    for (let i = 0; i < 4; i++) {
      history.push(textMessage(i % 2 === 0 ? "user" : "assistant", `旧消息${i}`));
    }
    // assistant tool_use 紧跟 user tool_result，边界恰好落在配对中间：
    // 总 16 条，len-10=6 恰是 tool_result 承载消息
    history.push(textMessage("user", "请修改文件"));
    history.push({
      role: "assistant",
      content: [
        { type: "text", text: "我来改" },
        { type: "tool_use", id: "tu_1", name: "Edit", input: { file: "a.ts" } },
      ],
    });
    history.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "改好了" },
      ],
    });
    for (let i = 0; i < 9; i++) {
      history.push(
        textMessage(i % 2 === 0 ? "assistant" : "user", `新消息${i}`)
      );
    }
    expect(history.getMessages()).toHaveLength(16);
    expect(
      history.getMessages()[6].content.some((b) => b.type === "tool_result")
    ).toBe(true);

    const client = fakeClient("摘要");
    const result = await forceCompact({
      history,
      client,
      config: fakeConfig(1_000_000),
    });
    expect(result.compacted).toBe(true);

    const messages = history.getMessages();
    // 扩窗一格：摘要 + 11 条（从 tool_use 承载的 assistant 消息开始）
    expect(messages).toHaveLength(12);
    const keepFirst = messages[1];
    expect(keepFirst.role).toBe("assistant");
    expect(keepFirst.content.some((b) => b.type === "tool_use")).toBe(true);
    expect(keepFirst.content.some((b) => b.type === "tool_result")).toBe(false);
    expectAllToolUsesPaired(messages);
  });

  it("连续多条 tool_result 消息时多步扩窗，直到边界不再是 tool_result", async () => {
    const history = new History();
    // 旧历史凑数：索引 0-4
    for (let i = 0; i < 5; i++) {
      history.push(textMessage(i % 2 === 0 ? "user" : "assistant", `旧消息${i}`));
    }
    // 索引 5：assistant 一次发出两个 tool_use；
    // 索引 6、7：两个 tool_result 拆成连续两条 user 消息
    history.push({
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu_a", name: "Read", input: { file: "a.ts" } },
        { type: "tool_use", id: "tu_b", name: "Read", input: { file: "b.ts" } },
      ],
    });
    history.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_a", content: "A内容" }],
    });
    history.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_b", content: "B内容" }],
    });
    // 索引 8-16：9 条普通消息，总计 17 条 → 默认切点 17-10=7 恰是第二条 tool_result
    for (let i = 0; i < 9; i++) {
      history.push(
        textMessage(i % 2 === 0 ? "assistant" : "user", `新消息${i}`)
      );
    }
    expect(history.getMessages()).toHaveLength(17);
    for (const idx of [6, 7]) {
      expect(
        history.getMessages()[idx].content.some((b) => b.type === "tool_result")
      ).toBe(true);
    }

    const client = fakeClient("摘要");
    const result = await forceCompact({
      history,
      client,
      config: fakeConfig(1_000_000),
    });
    expect(result.compacted).toBe(true);

    const messages = history.getMessages();
    // 扩窗两格：摘要 + 12 条（从 tool_use 承载的 assistant 消息开始）
    expect(messages).toHaveLength(13);
    const keepFirst = messages[1];
    expect(keepFirst.role).toBe("assistant");
    expect(
      keepFirst.content.filter((b) => b.type === "tool_use").map((b) => b.id)
    ).toEqual(["tu_a", "tu_b"]);
    expect(
      messages[2].content.some(
        (b) => b.type === "tool_result" && b.tool_use_id === "tu_a"
      )
    ).toBe(true);
    expect(
      messages[3].content.some(
        (b) => b.type === "tool_result" && b.tool_use_id === "tu_b"
      )
    ).toBe(true);

    // 保留窗口内每个 tool_result 都能在更早的保留消息里找到配对 tool_use
    const keptToolUseIds = new Set(
      messages.flatMap((m) =>
        m.content.filter((b) => b.type === "tool_use").map((b) => b.id)
      )
    );
    for (const m of messages) {
      for (const b of m.content) {
        if (b.type === "tool_result") {
          expect(keptToolUseIds.has(b.tool_use_id)).toBe(true);
        }
      }
    }
  });
});

describe("forceCompact", () => {
  it("历史太短时友好返回、不调用 API", async () => {
    const history = buildHistory(4);
    const before = history.getMessages();
    const client = fakeClient("摘要");
    const result = await forceCompact({
      history,
      client,
      config: fakeConfig(1_000_000),
    });
    expect(result.compacted).toBe(false);
    expect(result.warning).toContain("太短");
    expect(client.calls).toHaveLength(0);
    expect(history.getMessages()).toEqual(before);
  });

  it("低于阈值也无条件压缩（与自动共用同一路径）", async () => {
    const history = buildHistory(20);
    const client = fakeClient("手动摘要");
    const result = await forceCompact({
      history,
      client,
      config: fakeConfig(1_000_000),
    });
    expect(result.compacted).toBe(true);
    expect(history.getMessages()).toHaveLength(KEEP_RECENT_MESSAGES + 1);
    expect(
      (history.getMessages()[0].content[0] as TextBlock).text
    ).toContain("手动摘要");
  });
});

describe("compact 与 Todo 清单", () => {
  it("压缩不影响 History 之外的 TodoWrite 清单", async () => {
    const todoStore: TodoStore = {
      todos: [
        { content: "写测试", status: "in_progress" },
        { content: "提交代码", status: "pending" },
      ],
    };
    const history = buildHistory(20, "x".repeat(200));
    const client = fakeClient("摘要");
    const result = await maybeCompact({
      history,
      client,
      config: fakeConfig(100),
    });
    expect(result.compacted).toBe(true);
    expect(todoStore.todos).toEqual([
      { content: "写测试", status: "in_progress" },
      { content: "提交代码", status: "pending" },
    ]);
  });
});
