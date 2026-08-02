import type { ApiClient, StreamMessageResult } from "../api/client.js";
import type { Config } from "../config.js";
import type { History } from "../session/history.js";
import type { ToolRegistry } from "../tools/registry.js";
import type {
  AgentEvent,
  ToolResultBlock,
  ToolUseBlock,
} from "../types/messages.js";
import type { ToolResult } from "../types/tools.js";
import type { PreToolUseHook } from "../types/hooks.js";

const DEFAULT_MAX_TOOL_CALLS = 200;
const DEFAULT_MAX_TOKENS = 8192;

export interface RunTurnOptions {
  userInput: string;
  history: History;
  registry: ToolRegistry;
  client: ApiClient;
  config: Config;
  system: string;
  signal?: AbortSignal;
  /** 工具执行前的裁决回调（插件 hooks 由调用方组装）；deny 转 is_error tool_result，不破坏配对 */
  preToolUse?: PreToolUseHook;
  onEvent: (event: AgentEvent) => void;
  maxToolCalls?: number;
  maxTokens?: number;
}

function endInterrupted(history: History, onEvent: (e: AgentEvent) => void): void {
  history.appendInterruptMarker();
  onEvent({ type: "turn_end", reason: "interrupted" });
}

async function executeTool(
  registry: ToolRegistry,
  toolUse: ToolUseBlock,
  signal?: AbortSignal,
  preToolUse?: PreToolUseHook
): Promise<ToolResult> {
  const tool = registry.get(toolUse.name);
  if (!tool) {
    return { content: `未知工具: ${toolUse.name}`, isError: true };
  }
  if (preToolUse) {
    try {
      const decision = await preToolUse(toolUse, { signal });
      if (decision.behavior === "deny") {
        return { content: decision.reason ?? "[插件拦截了本次工具调用]", isError: true };
      }
    } catch (err) {
      // 裁决器自身异常按 fail-closed 处理：不执行工具
      const message = err instanceof Error ? err.message : String(err);
      return { content: `[插件 hook 异常，按 fail-closed 拦截] ${message}`, isError: true };
    }
  }
  try {
    return await tool.execute(toolUse.input, { signal });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `工具执行异常: ${message}`, isError: true };
  }
}

export async function runTurn(opts: RunTurnOptions): Promise<void> {
  const { history, registry, client, config, signal, onEvent } = opts;
  const maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  let executed = 0;

  history.push({ role: "user", content: [{ type: "text", text: opts.userInput }] });

  for (;;) {
    let response: StreamMessageResult;
    try {
      response = await client.streamMessage({
        system: opts.system,
        messages: history.getMessages(),
        tools: registry.list(),
        model: config.model,
        maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        effort: config.effort,
        signal,
        onEvent,
      });
    } catch (err) {
      if (signal?.aborted) {
        endInterrupted(history, onEvent);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", message });
      onEvent({ type: "turn_end", reason: "end_turn" });
      return;
    }

    history.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use"
    );
    if (toolUses.length === 0) {
      if (signal?.aborted) {
        endInterrupted(history, onEvent);
        return;
      }
      onEvent({ type: "turn_end", reason: "end_turn" });
      return;
    }

    // 同一响应内的多个 tool_use 并行执行；tool_result 按 tool_use 原顺序落位。
    // 单个失败以 is_error 回填不影响其余；上限占位与中断占位保证 history 配对合法。
    const results: ToolResultBlock[] = new Array(toolUses.length);
    let hitLimit = false;
    let interrupted = false;

    if (signal?.aborted) {
      interrupted = true;
      for (let i = 0; i < toolUses.length; i++) {
        results[i] = {
          type: "tool_result",
          tool_use_id: toolUses[i].id,
          content: "[未执行——回合被中断]",
          is_error: true,
        };
      }
    } else {
      const runnable: number[] = [];
      for (let i = 0; i < toolUses.length; i++) {
        if (executed >= maxToolCalls) {
          hitLimit = true;
          results[i] = {
            type: "tool_result",
            tool_use_id: toolUses[i].id,
            content: "[已达单回合工具调用上限，未执行]",
            is_error: true,
          };
        } else {
          executed++;
          runnable.push(i);
        }
      }
      await Promise.all(
        runnable.map(async (i) => {
          const toolUse = toolUses[i];
          onEvent({
            type: "tool_start",
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          });
          const result = await executeTool(registry, toolUse, signal, opts.preToolUse);
          onEvent({
            type: "tool_end",
            id: toolUse.id,
            name: toolUse.name,
            result: result.content,
            isError: result.isError === true,
          });
          const block: ToolResultBlock = {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.content,
          };
          if (result.isError) block.is_error = true;
          results[i] = block;
        })
      );
      // 执行途中被中断：工具已各自响应 signal 收尾并返回结果，配对仍完整
      if (signal?.aborted) interrupted = true;
    }

    if (interrupted) {
      // 已完成的 tool_result 保留，未执行的已回填占位，history 配对合法
      history.push({ role: "user", content: results });
      endInterrupted(history, onEvent);
      return;
    }

    history.push({ role: "user", content: results });

    if (hitLimit || executed >= maxToolCalls) {
      onEvent({ type: "turn_end", reason: "max_tool_calls" });
      return;
    }
  }
}
