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
  toolUse: ToolUseBlock
): Promise<ToolResult> {
  const tool = registry.get(toolUse.name);
  if (!tool) {
    return { content: `未知工具: ${toolUse.name}`, isError: true };
  }
  try {
    return await tool.execute(toolUse.input);
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

    if (signal?.aborted) {
      // 流刚结束即被中断：丢弃本次 assistant 输出
      endInterrupted(history, onEvent);
      return;
    }

    history.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use"
    );
    if (toolUses.length === 0) {
      onEvent({ type: "turn_end", reason: "end_turn" });
      return;
    }

    const results: ToolResultBlock[] = [];
    let hitLimit = false;
    let interrupted = false;

    for (const toolUse of toolUses) {
      if (signal?.aborted) {
        interrupted = true;
        break;
      }
      if (executed >= maxToolCalls) {
        hitLimit = true;
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "[已达单回合工具调用上限，未执行]",
          is_error: true,
        });
        continue;
      }
      executed++;
      onEvent({
        type: "tool_start",
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      });
      const result = await executeTool(registry, toolUse);
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
      results.push(block);
    }

    if (interrupted) {
      // 保留已完成回填的 tool_result，丢弃未执行的 tool_use
      if (results.length > 0) history.push({ role: "user", content: results });
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
