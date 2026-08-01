import type { ApiClient } from "../api/client.js";
import type { Config } from "../config.js";
import type { History } from "../session/history.js";
import type { ContentBlock, Message, TextBlock } from "../types/messages.js";

export const SUMMARY_PREFIX = "[历史摘要]";
export const KEEP_RECENT_MESSAGES = 10;

const COMPACT_THRESHOLD_RATIO = 0.8;
const SUMMARY_MAX_TOKENS = 4096;
const TOOL_RESULT_EXCERPT_CHARS = 2000;
const TOOL_INPUT_EXCERPT_CHARS = 500;
const TOO_SHORT_WARNING = "会话历史太短，无需压缩。";

export interface CompactDeps {
  history: History;
  client: ApiClient;
  config: Config;
  system?: string;
}

export interface CompactResult {
  compacted: boolean;
  warning?: string;
  beforeTokens: number;
  afterTokens: number;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[已截断，原文共 ${text.length} 字符]`;
}

function blockToText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_use":
      return `[工具调用 ${block.name}] 输入: ${truncate(
        JSON.stringify(block.input),
        TOOL_INPUT_EXCERPT_CHARS
      )}`;
    case "tool_result":
      return `[工具结果${block.is_error ? "（失败）" : ""}] ${truncate(
        block.content,
        TOOL_RESULT_EXCERPT_CHARS
      )}`;
  }
}

function messageToText(message: Message): string {
  const role = message.role === "user" ? "用户" : "助手";
  return `${role}:\n${message.content.map(blockToText).join("\n")}`;
}

function buildSummaryRequest(oldMessages: Message[]): string {
  return [
    "请将下面的会话历史压缩为一份简明摘要，后续对话将以这份摘要代替原始历史继续进行。",
    "摘要必须保留：",
    "1. 用户已做出的决策（包括对 AskUserQuestion 提问的回答）；",
    "2. 当前任务状态（已完成的、进行中的、待办的）；",
    "3. 已改动的文件清单（文件路径与改动要点）。",
    "只输出摘要正文，不要输出其他解释。",
    "",
    "=== 会话历史开始 ===",
    oldMessages.map(messageToText).join("\n\n"),
    "=== 会话历史结束 ===",
  ].join("\n");
}

function containsToolResult(message: Message): boolean {
  return message.content.some((b) => b.type === "tool_result");
}

/**
 * 配对安全切点：保留窗口默认从倒数第 N 条开始；若首条是 tool_result 承载消息
 * （意味着其配对的 assistant tool_use 会被切进旧历史），向旧侧扩窗直到边界合法。
 */
function findSafeKeepStart(messages: Message[]): number {
  let start = messages.length - KEEP_RECENT_MESSAGES;
  while (start > 0 && containsToolResult(messages[start])) start--;
  return start;
}

async function doCompact(deps: CompactDeps): Promise<CompactResult> {
  const beforeTokens = deps.history.estimateTokens();
  const messages = deps.history.getMessages();
  const start = findSafeKeepStart(messages);
  if (start <= 0) {
    return {
      compacted: false,
      warning: TOO_SHORT_WARNING,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  const oldMessages = messages.slice(0, start);
  const keep = messages.slice(start);

  let summary: string;
  try {
    const response = await deps.client.streamMessage({
      system: deps.system ?? "",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildSummaryRequest(oldMessages) }],
        },
      ],
      tools: [],
      model: deps.config.model,
      maxTokens: SUMMARY_MAX_TOKENS,
      onEvent: () => {},
    });
    summary = response.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      compacted: false,
      warning: `压缩失败，已保留原历史：${message}`,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  if (!summary) {
    return {
      compacted: false,
      warning: "压缩失败，已保留原历史：模型未返回摘要内容",
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  deps.history.replaceAll([
    {
      role: "user",
      content: [{ type: "text", text: `${SUMMARY_PREFIX}\n${summary}` }],
    },
    ...keep,
  ]);
  return {
    compacted: true,
    beforeTokens,
    afterTokens: deps.history.estimateTokens(),
  };
}

/** 自动压缩入口：超过上下文窗口 80% 才执行，否则无操作。 */
export async function maybeCompact(deps: CompactDeps): Promise<CompactResult> {
  const beforeTokens = deps.history.estimateTokens();
  if (beforeTokens <= deps.config.contextWindow * COMPACT_THRESHOLD_RATIO) {
    return { compacted: false, beforeTokens, afterTokens: beforeTokens };
  }
  return doCompact(deps);
}

/** 手动压缩入口（/compact）：无条件执行，与自动共用 doCompact。 */
export async function forceCompact(deps: CompactDeps): Promise<CompactResult> {
  return doCompact(deps);
}
