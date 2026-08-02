import { describe, expect, it } from "vitest";
import { runTurn } from "../../src/agent/loop.js";
import type {
  ApiClient,
  StreamMessageOptions,
  StreamMessageResult,
} from "../../src/api/client.js";
import type { Config } from "../../src/config.js";
import { History, INTERRUPT_MARKER } from "../../src/session/history.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type {
  AgentEvent,
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from "../../src/types/messages.js";
import type { Tool, ToolResult } from "../../src/types/tools.js";

const config: Config = {
  apiKey: "test-key",
  baseUrl: "http://localhost",
  model: "test-model",
  contextWindow: 200_000,
};

function fakeClient(
  responses: StreamMessageResult[] | (() => StreamMessageResult)
): ApiClient & { calls: StreamMessageOptions[] } {
  const calls: StreamMessageOptions[] = [];
  return {
    calls,
    async streamMessage(opts: StreamMessageOptions): Promise<StreamMessageResult> {
      calls.push(opts);
      const response = Array.isArray(responses) ? responses.shift() : responses();
      if (!response) throw new Error("fake client: no more responses");
      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          opts.onEvent({ type: "text_delta", text: block.text });
        }
      }
      return response;
    },
  };
}

function makeTool(
  name: string,
  execute: (input: unknown) => Promise<ToolResult>
): Tool {
  return {
    name,
    description: `fake tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    execute,
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}) {
  return { type: "tool_use" as const, id, name, input };
}

function textResponse(text: string): StreamMessageResult {
  return { content: [{ type: "text", text }], stopReason: "end_turn" };
}

function expectAllToolUsesPaired(messages: Message[]): void {
  const toolUseIds = messages.flatMap((m) =>
    m.content.filter((b): b is ToolUseBlock => b.type === "tool_use").map((b) => b.id)
  );
  const resultIds = messages.flatMap((m) =>
    m.content
      .filter((b): b is ToolResultBlock => b.type === "tool_result")
      .map((b) => b.tool_use_id)
  );
  for (const id of toolUseIds) {
    expect(resultIds).toContain(id);
  }
}

describe("runTurn", () => {
  it("纯文本回合：user/assistant 入 history，发 turn_end(end_turn)", async () => {
    const history = new History();
    const client = fakeClient([textResponse("done")]);
    const events: AgentEvent[] = [];

    await runTurn({
      userInput: "hello",
      history,
      registry: new ToolRegistry(),
      client,
      config,
      system: "sys",
      onEvent: (e) => events.push(e),
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].system).toBe("sys");
    expect(client.calls[0].model).toBe("test-model");
    const messages = history.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] });
    expect(messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "done" }] });
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(events.some((e) => e.type === "tool_start")).toBe(false);
  });

  it("同一响应含 2 个 tool_use 时并行执行，结果按 tool_use 顺序回填", async () => {
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register(makeTool("alpha", async () => {
      order.push("alpha");
      return { content: "alpha-out" };
    }));
    registry.register(makeTool("beta", async () => {
      order.push("beta");
      return { content: "beta-out" };
    }));

    const history = new History();
    const client = fakeClient([
      { content: [toolUse("t1", "alpha"), toolUse("t2", "beta")], stopReason: "tool_use" },
      textResponse("finished"),
    ]);
    const events: AgentEvent[] = [];

    await runTurn({
      userInput: "run tools",
      history,
      registry,
      client,
      config,
      system: "sys",
      onEvent: (e) => events.push(e),
    });

    expect(order).toEqual(["alpha", "beta"]);
    // 并行：两个 tool_start 先后同步发出，tool_end 在其后（完成顺序不做保证）
    const toolEvents = events.filter((e) => e.type === "tool_start" || e.type === "tool_end");
    expect(toolEvents.slice(0, 2).map((e) => `${e.type}:${"name" in e ? e.name : ""}`)).toEqual([
      "tool_start:alpha",
      "tool_start:beta",
    ]);
    expect(toolEvents.filter((e) => e.type === "tool_end")).toHaveLength(2);

    const messages = history.getMessages();
    // user, assistant(tool_use), user(tool_result), assistant(text)
    expect(messages).toHaveLength(4);
    const resultBlocks = messages[2].content as ToolResultBlock[];
    expect(messages[2].role).toBe("user");
    expect(resultBlocks.map((b) => [b.tool_use_id, b.content])).toEqual([
      ["t1", "alpha-out"],
      ["t2", "beta-out"],
    ]);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
  });

  it("并行执行：慢工具不阻塞快工具完成，结果顺序仍与 tool_use 一致", async () => {
    const done: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const registry = new ToolRegistry();
    registry.register(makeTool("slow", async () => {
      await sleep(40);
      done.push("slow");
      return { content: "slow-out" };
    }));
    registry.register(makeTool("fast", async () => {
      await sleep(5);
      done.push("fast");
      return { content: "fast-out" };
    }));

    const history = new History();
    const client = fakeClient([
      { content: [toolUse("t1", "slow"), toolUse("t2", "fast")], stopReason: "tool_use" },
      textResponse("finished"),
    ]);

    await runTurn({
      userInput: "run tools",
      history,
      registry,
      client,
      config,
      system: "sys",
      onEvent: () => {},
    });

    // 快工具先完成 → 证明并发；结果块仍按 tool_use 原顺序
    expect(done).toEqual(["fast", "slow"]);
    const resultBlocks = history.getMessages()[2].content as ToolResultBlock[];
    expect(resultBlocks.map((b) => [b.tool_use_id, b.content])).toEqual([
      ["t1", "slow-out"],
      ["t2", "fast-out"],
    ]);
  });

  it("第 1 个工具失败以 is_error 回填，第 2 个仍执行", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("boom", async () => {
      throw new Error("kaboom");
    }));
    let betaRan = false;
    registry.register(makeTool("beta", async () => {
      betaRan = true;
      return { content: "beta-out" };
    }));

    const history = new History();
    const client = fakeClient([
      { content: [toolUse("t1", "boom"), toolUse("t2", "beta")], stopReason: "tool_use" },
      textResponse("ok"),
    ]);
    const events: AgentEvent[] = [];

    await runTurn({
      userInput: "go",
      history,
      registry,
      client,
      config,
      system: "sys",
      onEvent: (e) => events.push(e),
    });

    expect(betaRan).toBe(true);
    const resultBlocks = history.getMessages()[2].content as ToolResultBlock[];
    expect(resultBlocks[0].is_error).toBe(true);
    expect(resultBlocks[0].content).toContain("kaboom");
    expect(resultBlocks[1].is_error).toBeUndefined();
    const failEnd = events.find((e) => e.type === "tool_end" && e.id === "t1");
    expect(failEnd && failEnd.type === "tool_end" && failEnd.isError).toBe(true);
  });

  it("达到可注入上限（3）后停止执行并发 turn_end(max_tool_calls)", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(makeTool("worker", async () => {
      executions++;
      return { content: `run-${executions}` };
    }));

    let batch = 0;
    const client = fakeClient(() => {
      batch++;
      return {
        content: [
          toolUse(`b${batch}-1`, "worker"),
          toolUse(`b${batch}-2`, "worker"),
        ],
        stopReason: "tool_use",
      };
    });

    const history = new History();
    const events: AgentEvent[] = [];
    await runTurn({
      userInput: "loop forever",
      history,
      registry,
      client,
      config,
      system: "sys",
      onEvent: (e) => events.push(e),
      maxToolCalls: 3,
    });

    expect(executions).toBe(3);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "max_tool_calls" });
    const lastResults = history.getMessages().at(-1)!.content as ToolResultBlock[];
    expect(lastResults[1].is_error).toBe(true);
    expect(lastResults[1].content).toContain("上限");
  });

  it("abort 中断（批内执行中）：并行批内工具各自收尾，结果配对完整，末尾追加中断标记", async () => {
    const controller = new AbortController();
    const registry = new ToolRegistry();
    let betaRan = false;
    registry.register(makeTool("first", async () => {
      controller.abort();
      return { content: "first-done" };
    }));
    registry.register(makeTool("second", async () => {
      betaRan = true;
      return { content: "second-done" };
    }));

    const history = new History();
    const client = fakeClient([
      { content: [toolUse("t1", "first"), toolUse("t2", "second")], stopReason: "tool_use" },
    ]);
    const events: AgentEvent[] = [];

    await runTurn({
      userInput: "interrupt me",
      history,
      registry,
      client,
      config,
      system: "sys",
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });

    // 并行语义：批内工具已同时启动，中断不撤销同批工具，各自收尾（真实工具经 signal 自行终止）
    expect(betaRan).toBe(true);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "interrupted" });

    const messages = history.getMessages();
    const last = messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toEqual([{ type: "text", text: INTERRUPT_MARKER }]);
    const resultMessage = messages.at(-2)!;
    expect(resultMessage.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "first-done" },
      { type: "tool_result", tool_use_id: "t2", content: "second-done" },
    ]);
    expectAllToolUsesPaired(messages);
  });

  it("abort 中断（首个工具执行前）：全部 tool_use 回填占位", async () => {
    const controller = new AbortController();
    const executedTools: string[] = [];
    const registry = new ToolRegistry();
    registry.register(makeTool("first", async () => {
      executedTools.push("first");
      return { content: "first-done" };
    }));
    registry.register(makeTool("second", async () => {
      executedTools.push("second");
      return { content: "second-done" };
    }));

    const history = new History();
    const client: ApiClient = {
      async streamMessage(): Promise<StreamMessageResult> {
        controller.abort();
        return {
          content: [toolUse("t1", "first"), toolUse("t2", "second")],
          stopReason: "tool_use",
        };
      },
    };
    const events: AgentEvent[] = [];

    await runTurn({
      userInput: "interrupt before tools",
      history,
      registry,
      client,
      config,
      system: "sys",
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });

    expect(executedTools).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "interrupted" });

    const messages = history.getMessages();
    expect(messages.at(-1)!.content).toEqual([
      { type: "text", text: INTERRUPT_MARKER },
    ]);
    expect(messages.at(-2)!.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "[未执行——回合被中断]",
        is_error: true,
      },
      {
        type: "tool_result",
        tool_use_id: "t2",
        content: "[未执行——回合被中断]",
        is_error: true,
      },
    ]);
    expectAllToolUsesPaired(messages);
  });

  it("API 报错时发 error 事件，不崩溃", async () => {
    const client: ApiClient = {
      async streamMessage() {
        throw new Error("network down");
      },
    };
    const events: AgentEvent[] = [];
    await runTurn({
      userInput: "hi",
      history: new History(),
      registry: new ToolRegistry(),
      client,
      config,
      system: "sys",
      onEvent: (e) => events.push(e),
    });
    expect(events[0]).toEqual({ type: "error", message: "network down" });
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
  });
});
