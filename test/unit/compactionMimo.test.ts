import { describe, expect, it } from "vitest";
import {
  forceCompact,
  maybeCompact,
  SUMMARY_PREFIX,
  listCompactionStrategies,
} from "../../src/agent/compaction/index.js";
import {
  checkpointThresholds,
  computeTailStart,
} from "../../src/agent/compaction/mimo.js";
import { History } from "../../src/session/history.js";
import type {
  ApiClient,
  StreamMessageOptions,
  StreamMessageResult,
} from "../../src/api/client.js";
import type { Config } from "../../src/config.js";
import type { Message, TextBlock } from "../../src/types/messages.js";

function mimoConfig(contextWindow: number): Config {
  return {
    apiKey: "key",
    baseUrl: "https://example.test",
    model: "deepseek-v4-pro",
    contextWindow,
    compactionStrategy: "mimo",
  };
}

interface FakeClient extends ApiClient {
  calls: StreamMessageOptions[];
}

function fakeClient(text = "§1 活跃意图\n> 修复登录 bug\n§2 下一步\n跑测试"): FakeClient {
  const calls: StreamMessageOptions[] = [];
  return {
    calls,
    async streamMessage(opts): Promise<StreamMessageResult> {
      calls.push(opts);
      return { content: [{ type: "text", text }], stopReason: "end_turn" };
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

function textMessage(role: "user" | "assistant", text: string, pad = 0): Message {
  return { role, content: [{ type: "text", text: text + "x".repeat(pad) }] };
}

/** 约 tokens 数的 padding 字符数 */
const tok = (n: number) => n * 4;

describe("mimo 策略注册与阈值阶梯", () => {
  it("registry 列出 mimo 策略", () => {
    expect(listCompactionStrategies().map((s) => s.id)).toContain("mimo");
  });

  it("阈值阶梯按窗口大小分档，且不超过 usable 上限", () => {
    expect(checkpointThresholds(20_000)).toEqual([]);
    // 100K 窗口：20/40/60/80% = 20K/40K/60K/80K，usable=60K → 80K 被滤掉
    expect(checkpointThresholds(100_000)).toEqual([20_000, 40_000, 60_000]);
    // 1M 窗口：每 5% 一档共 18 档
    expect(checkpointThresholds(1_000_000)).toHaveLength(18);
    expect(checkpointThresholds(1_000_000)[0]).toBe(50_000);
  });
});

describe("mimo 策略：阈值检查点更新（历史不改动）", () => {
  it("跨过阈值时更新检查点：调用一次 LLM、历史原样、返回 notice；同档不重复触发", async () => {
    const history = new History();
    // 200K 窗口阈值 [40K, 80K, 120K, 160K]；构造约 50K token 历史
    for (let i = 0; i < 10; i++) {
      history.push(
        textMessage(i % 2 === 0 ? "user" : "assistant", `消息${i}`, tok(5_000))
      );
    }
    const before = history.getMessages();
    const client = fakeClient();
    const config = mimoConfig(200_000);

    const first = await maybeCompact({ history, client, config });
    expect(first.compacted).toBe(false);
    expect(first.warning).toBeUndefined();
    expect(first.notice).toContain("检查点");
    expect(client.calls).toHaveLength(1);
    expect(history.getMessages()).toEqual(before);
    // 检查点请求走专用 system 与九节模板
    const req = (client.calls[0].messages[0].content[0] as TextBlock).text;
    expect(req).toContain("<new-conversation>");
    expect(req).toContain("§1 活跃意图");

    // 同一档不重复触发
    const second = await maybeCompact({ history, client, config });
    expect(second.compacted).toBe(false);
    expect(second.notice).toBeUndefined();
    expect(client.calls).toHaveLength(1);
  });

  it("再次跨档时携带上次检查点做增量更新", async () => {
    const history = new History();
    for (let i = 0; i < 10; i++) {
      history.push(
        textMessage(i % 2 === 0 ? "user" : "assistant", `消息${i}`, tok(5_000))
      );
    }
    const client = fakeClient("第一版检查点内容");
    const config = mimoConfig(200_000);
    await maybeCompact({ history, client, config });

    // 增长到跨过 80K 档
    for (let i = 0; i < 8; i++) {
      history.push(
        textMessage(i % 2 === 0 ? "user" : "assistant", `新消息${i}`, tok(5_000))
      );
    }
    await maybeCompact({ history, client, config });
    expect(client.calls).toHaveLength(2);
    const req = (client.calls[1].messages[0].content[0] as TextBlock).text;
    expect(req).toContain("<previous-checkpoint>");
    expect(req).toContain("第一版检查点内容");
    // 增量只含新消息（旧消息序列化为 "[用户]: 消息0x…"，不应再出现）
    expect(req).toContain("新消息0");
    expect(req).not.toContain("[用户]: 消息0x");
  });
});

describe("mimo 策略：溢出本地重建", () => {
  it("溢出时重建为 [检查点转储载体, 尾窗]，重建本身零 LLM 调用", async () => {
    const history = new History();
    history.push(textMessage("user", "修复登录 bug"));
    // 30K+ token 历史：assistant 大消息 + 小用户消息，确保尾窗只保留一部分
    for (let i = 0; i < 15; i++) {
      history.push(textMessage("assistant", `工作${i}`, tok(2_000)));
      history.push(textMessage("user", `继续${i}`));
    }
    // 窗口 30K → usable=1024，必然溢出；阈值表为空（全部超 usable 被滤）
    const client = fakeClient("检查点正文ABC");
    const result = await forceCompact({
      history,
      client,
      config: mimoConfig(30_000),
    });
    expect(result.compacted).toBe(true);
    // 仅 1 次调用 = 检查点更新；重建零调用
    expect(client.calls).toHaveLength(1);

    const messages = history.getMessages();
    const carrier = (messages[0].content[0] as TextBlock).text;
    expect(carrier.startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(carrier).toContain("## 会话检查点");
    expect(carrier).toContain("检查点正文ABC");
    expect(carrier).toContain("最近用户输入（原文）");
    expect(carrier).toContain("修复登录 bug");
    expect(carrier).toContain("直接继续工作");
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);

    // 再次溢出：增量更新携带上次检查点
    for (let i = 0; i < 8; i++) {
      history.push(
        textMessage(i % 2 === 0 ? "user" : "assistant", `后续${i}`, tok(1_000))
      );
    }
    const again = await forceCompact({
      history,
      client,
      config: mimoConfig(30_000),
    });
    expect(again.compacted).toBe(true);
    expect(client.calls).toHaveLength(2);
    const req = (client.calls[1].messages[0].content[0] as TextBlock).text;
    expect(req).toContain("<previous-checkpoint>");
  });

  it("computeTailStart：边界落在 tool_result 载体时向旧侧扩到 tool_use 属主", () => {
    const big = tok(22_000);
    const messages: Message[] = [
      textMessage("user", "请求", big),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "x".repeat(big) } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "y".repeat(big) }],
      },
      textMessage("assistant", "收尾", big),
    ];
    // lastAsst=3，start=2 为 tool_result 且尾窗已超上限不扩容 → 配对安全回退到 1
    expect(computeTailStart(messages)).toBe(1);
  });
});

describe("mimo 策略：prune 工具输出裁剪", () => {
  it("最近 2 个用户回合外、40K 保护之外的旧工具输出置为占位符", async () => {
    const history = new History();
    // 回合 1：3 个工具配对；从新到旧累计 19K/38K（≤40K 受保护）、60K（tu_0 超出被裁）
    const sizes = [22_000, 19_000, 19_000];
    history.push(textMessage("user", "回合1请求"));
    for (let k = 0; k < 3; k++) {
      history.push({
        role: "assistant",
        content: [
          { type: "tool_use", id: `tu_${k}`, name: "Bash", input: { command: "ls" } },
        ],
      });
      history.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: `tu_${k}`, content: "o".repeat(tok(sizes[k])) },
        ],
      });
    }
    history.push(textMessage("assistant", "回合1完成"));
    // 回合 2、3：纯文本
    history.push(textMessage("user", "回合2请求"));
    history.push(textMessage("assistant", "回合2完成"));
    history.push(textMessage("user", "回合3请求"));
    history.push(textMessage("assistant", "回合3完成"));

    const client = fakeClient();
    // 大窗口不溢出：只做 prune + 检查点更新
    const result = await forceCompact({
      history,
      client,
      config: mimoConfig(1_000_000),
    });
    expect(result.compacted).toBe(false);
    expect(result.notice).toContain("裁剪");

    const messages = history.getMessages();
    const contentOf = (id: string) => {
      for (const m of messages) {
        for (const b of m.content) {
          if (b.type === "tool_result" && b.tool_use_id === id) return b.content;
        }
      }
      return undefined;
    };
    // 最旧的 tu_0 被裁剪；较新的 tu_1/tu_2 在 40K 保护内保留
    expect(contentOf("tu_0")).toContain("已被裁剪");
    expect(contentOf("tu_1")).toContain("oo");
    expect(contentOf("tu_2")).toContain("oo");
    // 配对结构完整（tool_result 块仍在原位）
    expect(messages.filter((m) => m.content.some((b) => b.type === "tool_result"))).toHaveLength(3);
  });
});

describe("mimo 策略：异常路径", () => {
  it("检查点更新失败时保留原历史并返回 warning", async () => {
    const history = new History();
    for (let i = 0; i < 8; i++) {
      history.push(
        textMessage(i % 2 === 0 ? "user" : "assistant", `消息${i}`, tok(1_000))
      );
    }
    const before = history.getMessages();
    const result = await forceCompact({
      history,
      client: failingClient(),
      config: mimoConfig(30_000),
    });
    expect(result.compacted).toBe(false);
    expect(result.warning).toContain("模拟 API 故障");
    expect(history.getMessages()).toEqual(before);
  });

  it("历史太短时友好返回、不调用 API", async () => {
    const history = new History();
    history.push(textMessage("user", "你好"));
    const client = fakeClient();
    const result = await forceCompact({
      history,
      client,
      config: mimoConfig(1_000_000),
    });
    expect(result.compacted).toBe(false);
    expect(result.warning).toContain("太短");
    expect(client.calls).toHaveLength(0);
  });
});
