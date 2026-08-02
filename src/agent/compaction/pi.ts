/**
 * pi 策略：移植自 pi-mono（packages/coding-agent/src/core/compaction/），
 * 适配本项目的扁平 Message[] 历史模型。要点：
 * - 按 token 预算保留最近消息（keepRecentTokens），而非固定条数；
 * - 结构化摘要（目标/约束/进度/决策/后续步骤/关键上下文）；
 * - 迭代更新：再次压缩时把上次摘要作为底稿增量合并，而非重新总结；
 * - 文件操作跟踪：从 Read/Write/Edit 工具调用累积读/改文件清单，跨多次压缩保留；
 * - 切分回合（split turn）：切点落在回合中间时对回合前缀单独摘要后合并。
 * 未移植：branch 摘要（本项目无会话分支）、budget 外部配置（常量即默认值）。
 */
import type { Message, TextBlock } from "../../types/messages.js";
import {
  SUMMARY_PREFIX,
  type CompactDeps,
  type CompactResult,
  type CompactionStrategy,
} from "./types.js";

/** 为模型响应预留的窗口余量：历史超过 contextWindow - reserve 即自动触发 */
const RESERVE_TOKENS = 16384;
/** 保留最近消息的 token 预算 */
const KEEP_RECENT_TOKENS = 20000;
const TOOL_RESULT_MAX_CHARS = 2000;
const TOO_SHORT_WARNING = "会话历史太短，无需压缩。";

const SUMMARIZATION_SYSTEM_PROMPT =
  "你是上下文摘要助手。你的任务是阅读一段用户与 AI 助手的对话，然后严格按指定格式输出结构化摘要。" +
  "不要继续对话，不要回答对话中的任何问题，只输出结构化摘要。";

const SUMMARY_FORMAT = `## 目标
[用户想完成什么？会话涉及多个任务时可列多项。]

## 约束与偏好
- [用户提出的约束、偏好或要求；没有则写"（无）"]

## 进度
### 已完成
- [x] [已完成的任务/改动]

### 进行中
- [ ] [当前工作]

### 受阻
- [阻碍进展的问题；没有则省略]

## 关键决策
- **[决策]**：[简要理由]

## 后续步骤
1. [接下来应做什么，按顺序列出]

## 关键上下文
- [继续工作所需的数据、示例或引用；没有则写"（无）"]

每节保持简洁。文件路径、函数名、报错信息必须原样保留。`;

const INITIAL_PROMPT = `以上 <conversation> 中是需要总结的会话历史。请生成一份结构化的上下文检查点摘要，供另一个 LLM 据此继续工作。

严格使用以下格式：

${SUMMARY_FORMAT}`;

const UPDATE_PROMPT = `以上 <conversation> 中是需要并入摘要的【新增】会话消息，<previous-summary> 中是已有摘要。

请把新信息合并进已有结构化摘要。规则：
- 保留已有摘要中的全部信息；
- 追加新消息中的进度、决策与上下文；
- 更新"进度"：已完成的条目从"进行中"移到"已完成"；
- 根据实际进展更新"后续步骤"；
- 文件路径、函数名、报错信息必须原样保留；
- 已不再相关的内容可以删除。

严格使用以下格式：

${SUMMARY_FORMAT}`;

const TURN_PREFIX_PROMPT = `以上 <conversation> 中是一个因过大而被截断的回合的【前缀】部分，其后缀（最近的工作）会被原样保留。

请总结前缀，为保留的后缀提供上下文：

## 原始请求
[用户在这个回合要求做什么？]

## 前期进展
- [前缀中的关键决策与已完成工作]

## 后缀所需上下文
- [理解保留部分所必需的信息]

保持简洁，聚焦于理解后缀所需的内容。`;

// ============================================================================
// token 估算与切点
// ============================================================================

function estimateMessageTokens(message: Message): number {
  return Math.ceil(JSON.stringify(message).length / 4);
}

function containsToolResult(message: Message): boolean {
  return message.content.some((b) => b.type === "tool_result");
}

/** 合法切点：不含 tool_result 的消息（tool_result 必须跟随其配对 tool_use 一起保留） */
function isCutPoint(message: Message): boolean {
  return !containsToolResult(message);
}

/** 回合起点：真实用户输入（不含 tool_result 的 user 消息） */
function isTurnStart(message: Message): boolean {
  return message.role === "user" && !containsToolResult(message);
}

interface CutPointResult {
  /** 保留窗口的首条消息下标 */
  cutIndex: number;
  /** 切分回合时该回合的起点下标；未切分为 -1 */
  turnStartIndex: number;
  isSplitTurn: boolean;
}

/**
 * 从最新消息向旧侧累计估算 token，达到 keepRecentTokens 后取其后最近的合法切点。
 * 切在 assistant 消息上是安全的：其 tool_use 的配对 tool_result 在更新侧，会被一并保留。
 */
function findCutPoint(
  messages: Message[],
  boundaryStart: number,
  keepRecentTokens: number
): CutPointResult {
  const cutPoints: number[] = [];
  for (let i = boundaryStart; i < messages.length; i++) {
    if (isCutPoint(messages[i])) cutPoints.push(i);
  }
  if (cutPoints.length === 0) {
    return { cutIndex: boundaryStart, turnStartIndex: -1, isSplitTurn: false };
  }

  let cutIndex = cutPoints[0];
  let accumulated = 0;
  for (let i = messages.length - 1; i >= boundaryStart; i--) {
    accumulated += estimateMessageTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      const candidate = cutPoints.find((p) => p >= i);
      if (candidate !== undefined) cutIndex = candidate;
      break;
    }
  }

  if (isTurnStart(messages[cutIndex])) {
    return { cutIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  for (let i = cutIndex - 1; i >= boundaryStart; i--) {
    if (isTurnStart(messages[i])) {
      return { cutIndex, turnStartIndex: i, isSplitTurn: true };
    }
  }
  return { cutIndex, turnStartIndex: -1, isSplitTurn: false };
}

// ============================================================================
// 文件操作跟踪
// ============================================================================

interface FileOps {
  read: Set<string>;
  modified: Set<string>;
}

function extractFileOps(messages: Message[], ops: FileOps): void {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      const path = block.input?.file_path;
      if (typeof path !== "string" || !path) continue;
      if (block.name === "Read") ops.read.add(path);
      else if (block.name === "Write" || block.name === "Edit")
        ops.modified.add(path);
    }
  }
}

/** 从上次摘要的 <read-files>/<modified-files> 标签恢复清单，实现跨次压缩累积 */
function extractFileOpsFromSummary(summary: string, ops: FileOps): void {
  const grab = (tag: string): string[] => {
    const m = summary.match(new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`));
    return m ? m[1].split("\n").filter(Boolean) : [];
  };
  for (const f of grab("read-files")) ops.read.add(f);
  for (const f of grab("modified-files")) ops.modified.add(f);
}

function formatFileOps(ops: FileOps): string {
  const modified = [...ops.modified].sort();
  const readOnly = [...ops.read].filter((f) => !ops.modified.has(f)).sort();
  const sections: string[] = [];
  if (readOnly.length > 0)
    sections.push(`<read-files>\n${readOnly.join("\n")}\n</read-files>`);
  if (modified.length > 0)
    sections.push(`<modified-files>\n${modified.join("\n")}\n</modified-files>`);
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

// ============================================================================
// 会话序列化（喂给摘要模型的纯文本，避免模型误以为要继续对话）
// ============================================================================

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[……已截断 ${text.length - maxChars} 字符]`;
}

function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const texts: string[] = [];
    const toolCalls: string[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        texts.push(block.text);
      } else if (block.type === "tool_use") {
        const args = Object.entries(block.input ?? {})
          .map(([k, v]) => `${k}=${truncateForSummary(JSON.stringify(v), 200)}`)
          .join(", ");
        toolCalls.push(`${block.name}(${args})`);
      } else if (block.type === "tool_result") {
        const label = block.is_error ? "[工具结果（失败）]" : "[工具结果]";
        parts.push(
          `${label}: ${truncateForSummary(block.content, TOOL_RESULT_MAX_CHARS)}`
        );
      }
    }
    if (msg.role === "user" && texts.length > 0) {
      parts.push(`[用户]: ${texts.join("\n")}`);
    } else if (msg.role === "assistant") {
      if (texts.length > 0) parts.push(`[助手]: ${texts.join("\n")}`);
      if (toolCalls.length > 0)
        parts.push(`[助手工具调用]: ${toolCalls.join("; ")}`);
    }
  }
  return parts.join("\n\n");
}

// ============================================================================
// 摘要生成
// ============================================================================

async function requestSummary(
  deps: CompactDeps,
  promptText: string,
  maxTokens: number
): Promise<string> {
  const response = await deps.client.streamMessage({
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: [{ type: "text", text: promptText }] },
    ],
    tools: [],
    model: deps.config.model,
    maxTokens,
    onEvent: () => {},
  });
  return response.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function generateHistorySummary(
  deps: CompactDeps,
  messages: Message[],
  previousSummary: string | undefined
): Promise<string> {
  const basePrompt = previousSummary ? UPDATE_PROMPT : INITIAL_PROMPT;
  let promptText = `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;
  return requestSummary(deps, promptText, Math.floor(0.8 * RESERVE_TOKENS));
}

async function generateTurnPrefixSummary(
  deps: CompactDeps,
  messages: Message[]
): Promise<string> {
  const promptText = `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n${TURN_PREFIX_PROMPT}`;
  return requestSummary(deps, promptText, Math.floor(0.5 * RESERVE_TOKENS));
}

// ============================================================================
// 策略实现
// ============================================================================

function unchanged(beforeTokens: number, warning?: string): CompactResult {
  return { compacted: false, warning, beforeTokens, afterTokens: beforeTokens };
}

async function doCompact(deps: CompactDeps): Promise<CompactResult> {
  const beforeTokens = deps.history.estimateTokens();
  const messages = deps.history.getMessages();

  // 识别上次压缩注入的摘要消息：作为迭代更新的底稿，不参与再次总结
  let previousSummary: string | undefined;
  let boundaryStart = 0;
  const first = messages[0];
  if (first?.role === "user" && first.content[0]?.type === "text") {
    const text = (first.content[0] as TextBlock).text;
    if (text.startsWith(SUMMARY_PREFIX)) {
      previousSummary = text.slice(SUMMARY_PREFIX.length).trim();
      boundaryStart = 1;
    }
  }

  const cut = findCutPoint(messages, boundaryStart, KEEP_RECENT_TOKENS);
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.cutIndex;
  const historyMessages = messages.slice(boundaryStart, historyEnd);
  const turnPrefixMessages = cut.isSplitTurn
    ? messages.slice(cut.turnStartIndex, cut.cutIndex)
    : [];

  if (historyMessages.length === 0 && turnPrefixMessages.length === 0) {
    return unchanged(beforeTokens, TOO_SHORT_WARNING);
  }

  const fileOps: FileOps = { read: new Set(), modified: new Set() };
  if (previousSummary) extractFileOpsFromSummary(previousSummary, fileOps);
  extractFileOps(historyMessages, fileOps);
  extractFileOps(turnPrefixMessages, fileOps);

  let summary: string;
  try {
    if (cut.isSplitTurn && turnPrefixMessages.length > 0) {
      let historyText = "（无更早历史）";
      if (historyMessages.length > 0) {
        historyText = await generateHistorySummary(
          deps,
          historyMessages,
          previousSummary
        );
      } else if (previousSummary) {
        historyText = previousSummary;
      }
      const prefixText = await generateTurnPrefixSummary(
        deps,
        turnPrefixMessages
      );
      summary = `${historyText}\n\n---\n\n**回合上下文（该回合被截断，以下为前缀摘要）：**\n\n${prefixText}`;
    } else {
      summary = await generateHistorySummary(
        deps,
        historyMessages,
        previousSummary
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return unchanged(beforeTokens, `压缩失败，已保留原历史：${message}`);
  }

  if (!summary) {
    return unchanged(
      beforeTokens,
      "压缩失败，已保留原历史：模型未返回摘要内容"
    );
  }

  summary += formatFileOps(fileOps);

  deps.history.replaceAll([
    {
      role: "user",
      content: [{ type: "text", text: `${SUMMARY_PREFIX}\n${summary}` }],
    },
    ...messages.slice(cut.cutIndex),
  ]);
  return {
    compacted: true,
    beforeTokens,
    afterTokens: deps.history.estimateTokens(),
  };
}

/** pi 策略：token 预算保留 + 结构化摘要 + 迭代更新 + 文件跟踪 */
export const piStrategy: CompactionStrategy = {
  id: "pi",
  label: "Pi（结构化摘要）",
  description:
    "移植自 pi 编码代理：按 token 预算保留最近约 2 万 token 消息，生成结构化摘要" +
    "（目标/进度/决策/后续步骤），再次压缩时增量更新既有摘要，并跨次累积读改文件清单；" +
    "剩余窗口不足 16k token 时自动触发。",
  shouldCompact(deps) {
    return (
      deps.history.estimateTokens() >
      deps.config.contextWindow - RESERVE_TOKENS
    );
  },
  compact: doCompact,
};
