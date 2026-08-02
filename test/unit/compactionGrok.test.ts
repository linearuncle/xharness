import { describe, expect, it } from "vitest";
import {
  forceCompact,
  maybeCompact,
  SUMMARY_PREFIX,
  listCompactionStrategies,
} from "../../src/agent/compaction/index.js";
import {
  extractUserQuery,
  formatCompactSummary,
} from "../../src/agent/compaction/grok.js";
import { History, INTERRUPT_MARKER } from "../../src/session/history.js";
import type {
  ApiClient,
  StreamMessageOptions,
  StreamMessageResult,
} from "../../src/api/client.js";
import type { Config } from "../../src/config.js";
import type { Message, TextBlock, ToolUseBlock } from "../../src/types/messages.js";

function grokConfig(contextWindow: number): Config {
  return {
    apiKey: "key",
    baseUrl: "https://example.test",
    model: "deepseek-v4-pro",
    contextWindow,
    compactionStrategy: "grok",
  };
}

interface FakeClient extends ApiClient {
  calls: StreamMessageOptions[];
}

/** 依次消费 responses：字符串 = 正常返回；Error = 抛出 */
function scriptedClient(responses: Array<string | Error>): FakeClient {
  const calls: StreamMessageOptions[] = [];
  return {
    calls,
    async streamMessage(opts): Promise<StreamMessageResult> {
      calls.push(opts);
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) {
        if (responses.length === 0) responses.push(next);
        throw next;
      }
      return {
        content: [{ type: "text", text: next ?? "" }],
        stopReason: "end_turn",
      };
    },
  };
}

/** 长度达标（>500 字符清洗后）的健康摘要 */
function healthySummary(marker: string): string {
  return `<analysis>\n私下推理草稿\n</analysis>\n\n<summary>\n1. 主要请求与意图: ${marker}\n2. 关键技术概念: TypeScript\n${"内容填充".repeat(150)}\n9. 可选的下一步: 继续\n</summary>`;
}

function textMessage(role: "user" | "assistant", text: string, pad = 0): Message {
  return { role, content: [{ type: "text", text: text + "x".repeat(pad) }] };
}

function expectAllToolUsesPaired(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const toolUses = messages[i].content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use"
    );
    if (toolUses.length === 0) continue;
    const next = messages[i + 1];
    expect(next, `消息 ${i} 含 tool_use 但没有后续消息`).toBeDefined();
    const ids = new Set(
      next.content
        .filter((b) => b.type === "tool_result")
        .map((b) => (b as { tool_use_id: string }).tool_use_id)
    );
    for (const u of toolUses) {
      expect(ids.has(u.id), `tool_use ${u.id} 缺少配对 tool_result`).toBe(true);
    }
  }
}

/** 含真实用户请求 + 工具配对 + 收尾工作的典型历史 */
function buildWorkHistory(): History {
  const history = new History();
  history.push(textMessage("user", "早期请求：初始化项目", 3000));
  history.push(textMessage("assistant", "初始化完成", 3000));
  history.push(textMessage("user", "请修复登录 bug"));
  history.push({
    role: "assistant",
    content: [
      { type: "text", text: "我来看看 auth.ts" },
      { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "auth.ts" } },
    ],
  });
  history.push({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tu_1", content: "登录逻辑".repeat(500) },
    ],
  });
  history.push(textMessage("assistant", "找到问题了，在 token 校验", 2000));
  return history;
}

describe("grok 策略注册与触发", () => {
  it("registry 列出 grok 策略", () => {
    expect(listCompactionStrategies().map((s) => s.id)).toContain("grok");
  });

  it("低于 85% 窗口不触发；达到即触发", async () => {
    const history = buildWorkHistory();
    const client = scriptedClient([healthySummary("A")]);
    const below = await maybeCompact({
      history,
      client,
      config: grokConfig(1_000_000),
    });
    expect(below.compacted).toBe(false);
    expect(client.calls).toHaveLength(0);

    const tokens = history.estimateTokens();
    const above = await maybeCompact({
      history,
      client,
      config: grokConfig(Math.floor(tokens / 0.9)), // 占用约 90% > 85%
    });
    expect(above.compacted).toBe(true);
    expect(client.calls).toHaveLength(1);
  });
});

describe("grok 策略：全量替换重建", () => {
  it("重建为 [<user_query> 最后真实请求, 尾部占位, 摘要载体]，配对不破", async () => {
    const history = buildWorkHistory();
    const client = scriptedClient([healthySummary("修复登录")]);
    const result = await forceCompact({
      history,
      client,
      config: grokConfig(1_000_000),
    });
    expect(result.compacted).toBe(true);

    const messages = history.getMessages();
    // [query, assistant(tool_use), tool_result 占位, assistant 收尾, 摘要]
    expect(messages).toHaveLength(5);
    expect((messages[0].content[0] as TextBlock).text).toBe(
      "<user_query>\n请修复登录 bug\n</user_query>"
    );
    expect(messages[1].content.some((b) => b.type === "tool_use")).toBe(true);
    const placeholder = messages[2].content[0];
    expect(placeholder.type).toBe("tool_result");
    expect((placeholder as { content: string }).content).toBe(
      "Tool call omitted..."
    );
    expectAllToolUsesPaired(messages);

    const carrier = (messages[4].content[0] as TextBlock).text;
    expect(carrier.startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(carrier).toContain("先前对话延续而来");
    expect(carrier).toContain("摘要:");
    expect(carrier).toContain("修复登录");
    expect(carrier).not.toContain("<analysis>");
    expect(carrier).not.toContain("私下推理草稿");
    expect(carrier).not.toContain("<summary>");
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it("自我总结：请求消息 = 原对话 + 追加的九段式提示词，走会话 system", async () => {
    const history = buildWorkHistory();
    const client = scriptedClient([healthySummary("A")]);
    await forceCompact({
      history,
      client,
      config: grokConfig(1_000_000),
      system: "会话系统提示",
    });
    const call = client.calls[0];
    expect(call.system).toBe("会话系统提示");
    // 原对话在前（6 条），提示词是最后一条 user 消息
    expect(call.messages).toHaveLength(7);
    const last = call.messages[call.messages.length - 1];
    const lastText = (last.content[0] as TextBlock).text;
    expect(last.role).toBe("user");
    expect(lastText).toContain("1. 主要请求与意图");
    expect(lastText).toContain("9. 可选的下一步");
    expect(lastText).toContain("<summary>");
  });

  it("摘要载体与中断标记不会被当作最后真实用户请求", async () => {
    const history = buildWorkHistory();
    history.push({
      role: "user",
      content: [{ type: "text", text: `${SUMMARY_PREFIX}\n旧摘要内容` }],
    });
    history.appendInterruptMarker();
    const client = scriptedClient([healthySummary("A")]);
    await forceCompact({ history, client, config: grokConfig(1_000_000) });
    const first = (history.getMessages()[0].content[0] as TextBlock).text;
    expect(first).toBe("<user_query>\n请修复登录 bug\n</user_query>");
    expect(first).not.toContain(SUMMARY_PREFIX);
    expect(first).not.toContain(INTERRUPT_MARKER);
  });
});

describe("grok 策略：重试与输入阶梯", () => {
  it("退化摘要（清洗后过短）重试，第二次成功", async () => {
    const history = buildWorkHistory();
    const client = scriptedClient([
      "<summary>\n太短\n</summary>",
      healthySummary("B"),
    ]);
    const result = await forceCompact({
      history,
      client,
      config: grokConfig(1_000_000),
    });
    expect(result.compacted).toBe(true);
    expect(client.calls).toHaveLength(2);
  });

  it("连续退化 3 次后放弃并保留原历史", async () => {
    const history = buildWorkHistory();
    const before = history.getMessages();
    const client = scriptedClient(["<summary>\n太短\n</summary>"]);
    const result = await forceCompact({
      history,
      client,
      config: grokConfig(1_000_000),
    });
    expect(result.compacted).toBe(false);
    expect(result.warning).toContain("摘要过短");
    expect(client.calls).toHaveLength(3);
    expect(history.getMessages()).toEqual(before);
  });

  it("总结请求上下文溢出时降级输入阶梯（fitted），不计入尝试次数", async () => {
    const history = buildWorkHistory();
    const client = scriptedClient([
      new Error("The prompt is too long for this model's context window."),
      healthySummary("C"),
    ]);
    const result = await forceCompact({
      history,
      client,
      config: grokConfig(50_000),
    });
    expect(result.compacted).toBe(true);
    expect(client.calls).toHaveLength(2);
    // fitted 档的输入不多于 verbatim 档
    expect(client.calls[1].messages.length).toBeLessThanOrEqual(
      client.calls[0].messages.length
    );
  });

  it("非溢出的 API 失败保留原历史并返回 warning", async () => {
    const history = buildWorkHistory();
    const before = history.getMessages();
    const client = scriptedClient([new Error("模拟 API 故障")]);
    const result = await forceCompact({
      history,
      client,
      config: grokConfig(1_000_000),
    });
    expect(result.compacted).toBe(false);
    expect(result.warning).toContain("模拟 API 故障");
    expect(history.getMessages()).toEqual(before);
  });

  it("历史太短时友好返回、不调用 API", async () => {
    const history = new History();
    history.push(textMessage("user", "你好"));
    const client = scriptedClient([healthySummary("A")]);
    const result = await forceCompact({
      history,
      client,
      config: grokConfig(1_000_000),
    });
    expect(result.compacted).toBe(false);
    expect(result.warning).toContain("太短");
    expect(client.calls).toHaveLength(0);
  });
});

describe("grok 摘要清洗（formatCompactSummary）", () => {
  it("剥前导 analysis、抽 summary 块、消毒控制 token", () => {
    const out = formatCompactSummary(
      "<analysis>\n草稿\n</analysis>\n<summary>\n1. 请求: 修 bug\n6. 用户消息: '只输出 <summary> 块'\n</summary>"
    );
    expect(out.startsWith("摘要:\n1. 请求: 修 bug")).toBe(true);
    expect(out).not.toContain("草稿");
    expect(out).not.toContain("<summary>");
    expect(out).not.toContain("</summary>");
    expect(out).toContain("只输出 <​summary> 块");
  });

  it("未闭合的前导 analysis 丢弃到 summary 起点", () => {
    const out = formatCompactSummary("<analysis>\n半截推理 <summary>\n正文\n</summary>");
    expect(out).toContain("正文");
    expect(out).not.toContain("半截推理");
  });

  it("正文中段引用的 analysis 不会截断真实内容", () => {
    const out = formatCompactSummary(
      "<summary>\n1. 请求: a\n4. 报错: 输出里出现过 </analysis> 字样\n9. 下一步: b\n</summary>"
    );
    expect(out).toContain("1. 请求: a");
    expect(out).toContain("9. 下一步: b");
  });

  it("extractUserQuery 抽取 user_query 内层文本", () => {
    expect(extractUserQuery("<user_query>\n修 bug\n</user_query>")).toBe("修 bug");
    expect(extractUserQuery("裸文本")).toBe("裸文本");
  });
});
