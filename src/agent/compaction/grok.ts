/**
 * grok 策略：移植自 grok-build（crates/common/xai-grok-compaction 的 code_compaction
 * 子系统 + xai-grok-shell 的宿主接线），适配本项目的扁平 Message[] 模型。
 *
 * 核心思想：**全量替换（full-replace）**——不选尾部保留窗口，把整个会话交给模型
 * "自我总结"（对话按原样作为上下文，九段式结构化摘要提示词作为最后一条 user 消息
 * 追加，区别于 pi 的"序列化为文本再喂给模型"），然后从零重建历史：
 *
 *   [<user_query> 最后一条真实用户请求, 最后回合之后的消息（工具结果占位）, 摘要载体]
 *
 * 移植要点：
 * - 输入阶梯 verbatim → fitted → lossy：总结请求自身上下文溢出时逐级缩小输入
 *   （fitted = 掐头保尾适配预算且不拆工具配对；lossy = 工具块打平成文本再适配 70% 窗口）；
 * - 退化摘要（清洗后 < 500 字符）按瞬态失败重试，总尝试上限 3 次；
 * - 摘要清洗：剥 <analysis> 草稿块、抽取 <summary> 块、对回显的控制 token 注入
 *   零宽空格消毒（防止污染下一回合）、压缩连续空行；
 * - 真实用户回合识别：跳过摘要载体、中断标记等合成消息；
 * - 触发阈值：85% 上下文窗口（DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT）。
 *
 * 未移植（宿主特性，本项目不适用）：two-pass 预触发、自动压缩 sticky 抑制、
 * AGENTS.md/user_info 重注入（我们的 system prompt 与项目指令在 history 之外每回合
 * 重建）、TODO/后台任务 <system-reminder>（TodoWrite 清单在 history 之外存活）。
 */
import type { Message, TextBlock, ToolResultBlock } from "../../types/messages.js";
import { INTERRUPT_MARKER } from "../../session/history.js";
import {
  SUMMARY_PREFIX,
  type CompactDeps,
  type CompactResult,
  type CompactionStrategy,
} from "./types.js";

/** 自动触发阈值：历史估算超过窗口 85% */
const THRESHOLD_PERCENT = 85;
/** 清洗后摘要低于此字符数视为退化，按瞬态失败重试 */
const MIN_SUMMARY_SEED_CHARS = 500;
/** 总尝试上限（首次 + 重试；输入阶梯降级不计入） */
const MAX_ATTEMPTS = 3;
/** 摘要输出的 max_tokens */
const SUMMARY_MAX_TOKENS = 8192;
/** fitted 档：为摘要输出预留的窗口余量 */
const SUMMARY_BUDGET_RESERVE_TOKENS = 32768;
/** lossy 档：输入压到窗口的 70% */
const LOSSY_WINDOW_RATIO = 0.7;
const TOOL_OMITTED_PLACEHOLDER = "Tool call omitted...";
const TOO_SHORT_WARNING = "会话历史太短，无需压缩。";
/** 摘要载体前导语（对应 grok-build 的 "This session is being continued..."） */
const CONTINUATION_PREAMBLE =
  "本会话从一段耗尽上下文窗口的先前对话延续而来，以下摘要覆盖了此前的对话内容。";

const STRUCTURED_SUMMARY_PROMPT = `你的任务是为目前为止的对话产出一份忠实、简明的摘要，使一个后继助手在早期回合被丢弃后能无缝继续工作。后继助手只能看到用户的原始请求和这份摘要。捕捉继续工作所需的一切——用户的明确请求、你最近的操作、关键技术细节、文件路径、命令、配置与架构决策——但要克制：优先使用紧凑的行文与简短引用，不要为凑篇幅堆内容。一份能放得下的聚焦摘要远比一份被截断的详尽摘要有用，控制在几千字以内。

重要：如果早期回合中已包含一份先前的压缩摘要（带 <summary> 标记或"${CONTINUATION_PREAMBLE.slice(0, 12)}"开头的前导语），把它视为早期历史的权威记录，将其中仍然相关的信息带入你的新摘要，确保信息不会在多次压缩间丢失。

在私下推理中回顾整个对话后再动笔；不要输出单独的分析块。最终摘要放在唯一的 <summary>...</summary> 块内，按以下编号小节组织。即使某节为空也要保留小节标题（写"无"）：

1. 主要请求与意图：用户所有明确请求及其underlying意图，保留细节、约束、范围边界与偏好。
2. 关键技术概念：讨论或依赖的所有重要技术、语言、框架、库、工具与模式。
3. 文件与代码段：每个查看、创建或修改过的文件。给出完整路径、它为何重要，以及相关代码——你写过或改过的代码给出完整片段（最近的修改必须完整），不要只写描述。
4. 报错与修复：遇到的每个错误、失败命令或测试/构建失败，根因与确切修复方式。来自用户反馈的修复要原样记录。
5. 问题排查：已解决的问题与进行中的诊断/排障，包括仍在验证的假设。
6. 全部用户消息：按顺序列出所有非工具结果的用户消息。这些对理解意图及其演变至关重要。注意：不要把本条总结指令本身算进去——它是系统生成的压缩提示，不是真实用户消息。
7. 待办任务：用户明确要求但尚未完成的任务。不要发明用户没有要求过的任务。
8. 当前工作：本次摘要请求之前你正在做的事，带上最近的文件名、代码、命令与状态。要具体到能从中断处直接续上。
9. 可选的下一步：与最近工作直接衔接的单个下一步，严格符合用户最近的明确请求。若上一任务已完成，只有在明确属于用户既定目标时才提议下一步，否则说明应先与用户确认。存在下一步时，从最近的消息中直接引用原文，说明你正在做什么、停在哪里，避免理解偏差。

重要：不要调用任何工具。只输出 <summary>...</summary> 块作为你的文本回复，闭合标签之后不要有任何内容。`;

// ============================================================================
// 失败分类（移植 failure.rs：上下文溢出按报错文本匹配，无稳定错误码）
// ============================================================================

function isContextLengthError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("too long for this model") ||
    m.includes("prompt is too long") ||
    m.includes("maximum prompt length") ||
    m.includes("maximum context length") ||
    m.includes("context_length_exceeded") ||
    (m.includes("current message") && m.includes("exceeds budget"))
  );
}

// ============================================================================
// 真实用户回合识别与尾部提取（移植 compaction_utils.rs）
// ============================================================================

function estimateMessageTokens(message: Message): number {
  return Math.ceil(JSON.stringify(message).length / 4);
}

function containsToolResult(message: Message): boolean {
  return message.content.some((b) => b.type === "tool_result");
}

function messageText(message: Message): string {
  return message.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** 抽取 <user_query> 内层文本；无标签则原样返回 */
export function extractUserQuery(text: string): string {
  const start = text.indexOf("<user_query>");
  if (start >= 0) {
    const contentStart = start + "<user_query>".length;
    const end = text.indexOf("</user_query>", contentStart);
    if (end >= 0) return text.slice(contentStart, end).trim();
  }
  return text.trim();
}

/** 真实用户回合：user、无 tool_result、文本非合成（非摘要载体/中断标记/空） */
function isRealUserMessage(message: Message): boolean {
  if (message.role !== "user" || containsToolResult(message)) return false;
  const text = extractUserQuery(messageText(message));
  if (!text) return false;
  if (text.startsWith(SUMMARY_PREFIX)) return false;
  if (text === INTERRUPT_MARKER) return false;
  return true;
}

/**
 * 最后一条真实用户消息之后的尾部：assistant 原样保留（tool_use 完整），
 * tool_result 载体消息保留配对结构但内容以占位符替换（省空间，配对不变量不破）；
 * 其余合成 user 消息丢弃。
 */
function buildRecentTail(messages: Message[], boundaryIndex: number): Message[] {
  const tail: Message[] = [];
  for (let i = boundaryIndex + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      tail.push(msg);
    } else if (containsToolResult(msg)) {
      tail.push({
        role: "user",
        content: msg.content
          .filter((b): b is ToolResultBlock => b.type === "tool_result")
          .map((b) => ({
            type: "tool_result" as const,
            tool_use_id: b.tool_use_id,
            content: TOOL_OMITTED_PLACEHOLDER,
            ...(b.is_error ? { is_error: true } : {}),
          })),
      });
    }
    // 合成 user 文本消息（中断标记等）不进尾部
  }
  return tail;
}

// ============================================================================
// 输入阶梯（移植 compaction.rs InputStage + compaction_utils fit/lossy）
// ============================================================================

/** verbatim：原样，仅去掉末尾悬空的 tool_use（无配对结果会被严格端点拒绝） */
function prepareVerbatim(messages: Message[]): Message[] {
  const out = [...messages];
  while (
    out.length > 0 &&
    out[out.length - 1].role === "assistant" &&
    out[out.length - 1].content.some((b) => b.type === "tool_use")
  ) {
    out.pop();
  }
  return out;
}

/**
 * fitted：从最新往旧累计，保留能塞进预算的后缀；起点若落在 tool_result 载体上
 * 继续后移（不拆配对）。全都塞不下时保留最后一条并截断其内容。
 */
function fitToBudget(messages: Message[], budgetTokens: number): Message[] {
  const total = messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
  if (total <= budgetTokens) return messages;

  let remaining = budgetTokens;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateMessageTokens(messages[i]);
    if (cost > remaining) break;
    remaining -= cost;
    start = i;
  }
  while (start < messages.length && containsToolResult(messages[start])) start++;
  if (start < messages.length) return messages.slice(start);

  // 单条消息就超预算：截断其文本内容保住最近的工作
  const last = messages[messages.length - 1];
  if (!last) return [];
  const maxChars = Math.max(budgetTokens, 1) * 4;
  return [
    {
      role: last.role,
      content: last.content.map((b) => {
        if (b.type === "text" && b.text.length > maxChars) {
          return { type: "text" as const, text: `${b.text.slice(0, maxChars)}\n[……为适配压缩窗口已截断]` };
        }
        if (b.type === "tool_result" && b.content.length > maxChars) {
          return { ...b, content: `${b.content.slice(0, maxChars)}\n[……为适配压缩窗口已截断]` };
        }
        return b;
      }),
    },
  ];
}

/** lossy：工具块打平成文本注记（不再有 tool_use/tool_result 结构），再适配 70% 窗口 */
function prepareLossy(messages: Message[], contextWindow: number): Message[] {
  const flattened: Message[] = [];
  for (const msg of messages) {
    const parts: string[] = [];
    for (const b of msg.content) {
      if (b.type === "text") {
        parts.push(b.text);
      } else if (b.type === "tool_use") {
        parts.push(`[工具调用 ${b.name}] 输入: ${JSON.stringify(b.input).slice(0, 500)}`);
      } else {
        parts.push(`[工具结果${b.is_error ? "（失败）" : ""}] ${b.content.slice(0, 500)}`);
      }
    }
    const text = parts.join("\n").trim();
    if (text) flattened.push({ role: msg.role, content: [{ type: "text", text }] });
  }
  return fitToBudget(flattened, Math.floor(contextWindow * LOSSY_WINDOW_RATIO));
}

// ============================================================================
// 摘要清洗（移植 summary.rs）
// ============================================================================

function stripLeadingScratchpad(inner: string): string {
  let s = inner.trim();
  const lead = s.replace(/^[#*\->\s]+/, "");
  if (!/^\d/.test(lead)) {
    const pos = s.lastIndexOf("</analysis>");
    if (pos >= 0) s = s.slice(pos + "</analysis>".length).trimStart();
  }
  if (s.startsWith("<summary>")) s = s.slice("<summary>".length).trimStart();
  return s;
}

/** 对回显的压缩控制 token 注入零宽空格，防止被下一回合当作活标签（先闭后开） */
function neutralizeControlTokens(text: string): string {
  return text
    .replace(/<\/summary>/g, "<\u200b/summary>")
    .replace(/<summary>/g, "<\u200bsummary>")
    .replace(/<\/analysis>/g, "<\u200b/analysis>")
    .replace(/<analysis>/g, "<\u200banalysis>");
}

/** 清洗模型原始输出：剥草稿块 → 抽 <summary> 块为"摘要:"正文 → 消毒 → 压空行 */
export function formatCompactSummary(raw: string): string {
  let result = raw;

  // 1) 剥掉前导 <analysis> 草稿块（可能多个；正文中段引用的不动，交给第 3 步消毒）
  for (;;) {
    const start = result.indexOf("<analysis>");
    if (start < 0) break;
    const summaryPos = result.indexOf("<summary>");
    const isLeading =
      summaryPos >= 0
        ? start < summaryPos ||
          result.slice(summaryPos + "<summary>".length, start).trim() === ""
        : result.slice(0, start).trim() === "";
    if (!isLeading) break;
    const rel = result.indexOf("</analysis>", start);
    if (rel >= 0) {
      result = result.slice(0, start) + result.slice(rel + "</analysis>".length);
    } else {
      // 未闭合的前导草稿：丢到下一个 <summary> 或结尾
      const dropTo = result.indexOf("<summary>", start);
      result = result.slice(0, start) + (dropTo >= 0 ? result.slice(dropTo) : "");
      break;
    }
  }

  // 2) 抽取最外层 <summary> 块 → "摘要:\n{内层}"（rfind 闭合标签，防正文回显截断）
  const start = result.indexOf("<summary>");
  const end = result.lastIndexOf("</summary>");
  if (start >= 0 && end > start) {
    const before = result.slice(0, start);
    const after = result.slice(end + "</summary>".length);
    const inner = stripLeadingScratchpad(
      result.slice(start + "<summary>".length, end).trim()
    );
    result = `${before}摘要:\n${inner}${after}`;
  }

  // 3) 消毒仍残留在正文里的控制 token
  result = neutralizeControlTokens(result);

  while (result.includes("\n\n\n")) result = result.replace(/\n\n\n/g, "\n\n");
  return result.trim();
}

// ============================================================================
// 策略实现
// ============================================================================

function unchanged(beforeTokens: number, warning?: string): CompactResult {
  return { compacted: false, warning, beforeTokens, afterTokens: beforeTokens };
}

async function requestSummary(deps: CompactDeps, input: Message[]): Promise<string> {
  const response = await deps.client.streamMessage({
    system: deps.system ?? "",
    messages: [
      ...input,
      { role: "user", content: [{ type: "text", text: STRUCTURED_SUMMARY_PROMPT }] },
    ],
    tools: [],
    model: deps.config.model,
    maxTokens: SUMMARY_MAX_TOKENS,
    onEvent: deps.onEvent ?? (() => {}),
  });
  return response.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function doCompact(deps: CompactDeps): Promise<CompactResult> {
  const beforeTokens = deps.history.estimateTokens();
  const messages = deps.history.getMessages();
  if (messages.length === 0 || beforeTokens < 1000) {
    return unchanged(beforeTokens, TOO_SHORT_WARNING);
  }

  // 采样：输入阶梯 verbatim → fitted → lossy；退化/空摘要重试，总尝试上限 3 次
  const stages: Array<() => Message[]> = [
    () => prepareVerbatim(messages),
    () =>
      fitToBudget(
        prepareVerbatim(messages),
        Math.max(deps.config.contextWindow - SUMMARY_BUDGET_RESERVE_TOKENS, 1024)
      ),
    () => prepareLossy(messages, deps.config.contextWindow),
  ];

  let cleaned: string | undefined;
  let attempts = 0;
  let stageIndex = 0;
  let lastError = "";
  while (cleaned === undefined) {
    if (attempts >= MAX_ATTEMPTS) {
      return unchanged(
        beforeTokens,
        `压缩失败，已保留原历史：${lastError || "模型连续返回过短（退化）摘要"}`
      );
    }
    attempts++;
    try {
      const raw = await requestSummary(deps, stages[stageIndex]());
      const candidate = formatCompactSummary(raw);
      if (candidate.length >= MIN_SUMMARY_SEED_CHARS) {
        cleaned = candidate;
      } else {
        // 退化摘要：按瞬态失败重试
        lastError = `摘要过短（${candidate.length} 字符，低于 ${MIN_SUMMARY_SEED_CHARS}）`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isContextLengthError(message) && stageIndex < stages.length - 1) {
        // 总结请求自身溢出：降级输入阶梯重试，不计入尝试次数
        stageIndex++;
        attempts--;
        continue;
      }
      return unchanged(beforeTokens, `压缩失败，已保留原历史：${message}`);
    }
  }

  // 全量替换重建：[<user_query> 最后真实请求, 尾部占位消息, 摘要载体]
  const boundaryIndex = messages.reduceRight(
    (found, _m, i) => (found >= 0 ? found : isRealUserMessage(messages[i]) ? i : -1),
    -1
  );
  const rebuilt: Message[] = [];
  if (boundaryIndex >= 0) {
    const query = extractUserQuery(messageText(messages[boundaryIndex]));
    rebuilt.push({
      role: "user",
      content: [{ type: "text", text: `<user_query>\n${query}\n</user_query>` }],
    });
  }
  rebuilt.push(...buildRecentTail(messages, boundaryIndex));
  rebuilt.push({
    role: "user",
    content: [
      {
        type: "text",
        text: `${SUMMARY_PREFIX}\n${CONTINUATION_PREAMBLE}\n\n${cleaned}`,
      },
    ],
  });

  deps.history.replaceAll(rebuilt);
  return {
    compacted: true,
    beforeTokens,
    afterTokens: deps.history.estimateTokens(),
  };
}

/** grok 策略：全量替换 + 九段式自我总结 + 输入阶梯降级 */
export const grokStrategy: CompactionStrategy = {
  id: "grok",
  label: "Grok（全量替换）",
  description:
    "移植自 xAI grok-build：让模型在自身上下文里对整个会话做九段式结构化自我总结" +
    "（请求/概念/文件/报错/排查/用户消息/待办/当前工作/下一步），然后全量重建历史：" +
    "最后一条用户请求 + 最近回合占位 + 摘要；总结输入溢出时按 verbatim→fitted→lossy " +
    "阶梯降级，过短摘要自动重试；超过窗口 85% 自动触发。",
  shouldCompact(deps) {
    return (
      deps.history.estimateTokens() * 100 >=
      deps.config.contextWindow * THRESHOLD_PERCENT
    );
  },
  compact: doCompact,
};
