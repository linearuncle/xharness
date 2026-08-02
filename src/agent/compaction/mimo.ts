/**
 * mimo 策略：移植自 MiMo-Code v0.1.9（packages/opencode/src/session/ 的
 * checkpoint.ts / prune.ts / overflow.ts 体系），即其"无限上下文"机制。
 *
 * 核心思想：**检查点 + 本地重建**，而非"溢出时才做一次大总结"：
 * - 用量每跨过一档阈值（窗口 ≤200K 每 20%，≤500K 每 10%，>500K 每 5%）就把
 *   "自上次检查点以来的增量"用 LLM 并入结构化检查点（九节模板，各节 token 预算），
 *   **历史不改动**——相当于持续维护一份随时可用的会话快照；
 * - 真正溢出（用量 ≥ usable = 窗口 - 压缩预留 20K - 输出预留 20K）时**不再调用
 *   LLM**：本地即时重建历史 = [检查点转储 + 最近用户输入原文(FIFO 16K) + 续接指令]
 *   + 配对安全尾窗（10K~20K token、至少 5 条含文本消息，从最后一条 assistant 前
 *   一条起）——重建瞬间完成，会话可无限继续；
 * - 检查点更新前先 **prune**：跳过最近 2 个用户回合，保护最近 40K 工具输出，
 *   更早的工具输出就地置为占位符（可释放 ≥20K 才执行），不动配对结构。
 *
 * 对本项目的适配（原实现为宿主级子系统）：checkpoint writer 从"并行子代理 +
 * 磁盘 checkpoint.md/MEMORY.md"改为回合前同步 LLM 调用 + 会话内存态
 * （WeakMap<History, State>，随进程存续）；未移植：任务树/活跃 actor/全局记忆/
 * 会话笔记等节（本项目无对应子系统）、writer 失败熔断、fork 模式缓存对齐。
 */
import type { Message, TextBlock } from "../../types/messages.js";
import { INTERRUPT_MARKER, type History } from "../../session/history.js";
import {
  SUMMARY_PREFIX,
  type CompactDeps,
  type CompactResult,
  type CompactionStrategy,
} from "./types.js";

/** 压缩过程预留（对应 overflow.ts COMPACTION_BUFFER） */
const RESERVED_TOKENS = 20_000;
/** 输出预留上限（对应 overflow.ts OUTPUT_CAP） */
const OUTPUT_CAP_TOKENS = 20_000;
/** 尾窗下限/上限与最少含文本消息数（对应 checkpoint.ts computeBoundary） */
const TAIL_MIN_TOKENS = 10_000;
const TAIL_MAX_TOKENS = 20_000;
const TAIL_MIN_TEXT_MESSAGES = 5;
/** prune：保护最近工具输出 / 最小释放量（对应 prune.ts） */
const PRUNE_PROTECT = 40_000;
const PRUNE_MINIMUM = 20_000;
const PRUNE_PLACEHOLDER = "[工具输出已被裁剪以释放上下文空间]";
/** 最近用户输入原文：总预算与单条上限（对应 checkpoint push_caps） */
const RECENT_USER_CAP = 16_000;
const RECENT_USER_PER_MSG = 2_000;
/** 检查点更新调用的输出上限 */
const CHECKPOINT_MAX_TOKENS = 8192;
const TOO_SHORT_WARNING = "会话历史太短，无需压缩。";

const CHECKPOINT_SYSTEM_PROMPT =
  "你是会话检查点维护助手。你的任务是阅读新增对话内容，把其中的信息并入既有检查点，" +
  "输出更新后的完整检查点。不要继续对话，不要回答对话中的问题，只输出检查点正文。";

/** 九节检查点模板（对应 CHECKPOINT_TEMPLATE 的适配版，含各节 token 预算提示） */
const CHECKPOINT_SECTIONS = `## §1 活跃意图（预算 ~500 token）
用户最近的明确请求，从对话中逐字引用（引用原文是行动依据，不要转述）。

## §2 下一步具体行动（~1000）
由 §1 与当前状态推导出的单个下一步；用户给过原话时附引用。

## §3 本会话指令（~800）
用户在本会话给出的工作方式要求与约束。

## §4 当前工作（~2000）
检查点之前正在做的事，给出具体文件路径与代码位置。

## §5 文件与代码段（~1500）
正在读改的文件清单，每项一行用途说明。

## §6 发现的知识（~2000）
本会话学到的、对后续工作有用的事实。

## §7 报错与修复（~1500）
遇到的错误与解决方式，最新的在前。

## §8 设计决策与讨论结论（~3000）
讨论得出但没有直接代码产物的决策，记录"为什么这么做"。

## §9 开放笔记（~800）
不属于以上各节的引用、未决问题、零散观察。`;

// ============================================================================
// 会话态（对应磁盘 checkpoint.md + watermark，这里存内存、随 History 对象存续）
// ============================================================================

interface MimoState {
  /** 当前检查点正文；undefined = 尚无可用检查点 */
  checkpoint?: string;
  /** 已并入检查点的消息数（watermark） */
  coveredCount: number;
  /** 已触发过的阈值档（token 数），重建后清空 */
  crossed: Set<number>;
}

const states = new WeakMap<History, MimoState>();

function stateOf(history: History): MimoState {
  let s = states.get(history);
  if (!s) {
    s = { coveredCount: 0, crossed: new Set() };
    states.set(history, s);
  }
  return s;
}

// ============================================================================
// 阈值与溢出（对应 prune.ts defaultThresholdsFor + overflow.ts usable）
// ============================================================================

function usableTokens(contextWindow: number): number {
  return Math.max(contextWindow - RESERVED_TOKENS - OUTPUT_CAP_TOKENS, 1024);
}

/** 检查点触发阶梯：窗口越大写得越勤，保证溢出时几乎总有新鲜检查点可用 */
export function checkpointThresholds(contextWindow: number): number[] {
  let percents: number[];
  if (contextWindow < 25_000) return [];
  if (contextWindow <= 200_000) percents = [20, 40, 60, 80];
  else if (contextWindow <= 500_000)
    percents = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  else percents = Array.from({ length: 18 }, (_, i) => (i + 1) * 5);
  const maxAllowed = usableTokens(contextWindow);
  return percents
    .map((p) => Math.floor((contextWindow * p) / 100))
    .filter((t) => t <= maxAllowed);
}

function nextUncrossedThreshold(
  tokens: number,
  contextWindow: number,
  crossed: Set<number>
): number | undefined {
  return checkpointThresholds(contextWindow).find(
    (t) => tokens >= t && !crossed.has(t)
  );
}

// ============================================================================
// 消息工具
// ============================================================================

function estimateMessageTokens(message: Message): number {
  return Math.ceil(JSON.stringify(message).length / 4);
}

function containsToolResult(message: Message): boolean {
  return message.content.some((b) => b.type === "tool_result");
}

function containsText(message: Message): boolean {
  return message.content.some((b) => b.type === "text");
}

function messageText(message: Message): string {
  return message.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function isRealUserMessage(message: Message): boolean {
  if (message.role !== "user" || containsToolResult(message)) return false;
  const text = messageText(message).trim();
  if (!text || text.startsWith(SUMMARY_PREFIX) || text === INTERRUPT_MARKER)
    return false;
  return true;
}

/** 超长用户输入截头留尾（对应 truncateVerbatimUserMsg：头 60% + 尾 30%） */
function truncateVerbatim(text: string, capTokens: number): string {
  if (Math.ceil(text.length / 4) <= capTokens) return text;
  const head = text.slice(0, Math.floor(capTokens * 0.6) * 4);
  const tail = text.slice(-Math.floor(capTokens * 0.3) * 4);
  return `${head}\n[……中间内容已省略……]\n${tail}`;
}

// ============================================================================
// prune：工具输出裁剪（对应 prune.ts / compaction.ts prune）
// ============================================================================

function pruneToolOutputs(history: History): number {
  const messages = history.getMessages();
  let userTurns = 0;
  let protectedTokens = 0;
  let prunable = 0;
  const pruneFrom: Array<{ msgIndex: number; blockIndex: number }> = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isRealUserMessage(msg)) userTurns++;
    if (userTurns < 2) continue; // 最近 2 个用户回合完全保护
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (block.type !== "tool_result" || block.content === PRUNE_PLACEHOLDER)
        continue;
      const cost = Math.ceil(block.content.length / 4);
      protectedTokens += cost;
      if (protectedTokens > PRUNE_PROTECT) {
        prunable += cost;
        pruneFrom.push({ msgIndex: i, blockIndex: j });
      }
    }
  }

  if (prunable < PRUNE_MINIMUM) return 0;
  const marked = new Map<number, Set<number>>();
  for (const p of pruneFrom) {
    if (!marked.has(p.msgIndex)) marked.set(p.msgIndex, new Set());
    marked.get(p.msgIndex)!.add(p.blockIndex);
  }
  history.replaceAll(
    messages.map((msg, i) => {
      const blocks = marked.get(i);
      if (!blocks) return msg;
      return {
        role: msg.role,
        content: msg.content.map((b, j) =>
          blocks.has(j) && b.type === "tool_result"
            ? { ...b, content: PRUNE_PLACEHOLDER }
            : b
        ),
      };
    })
  );
  return prunable;
}

// ============================================================================
// 检查点更新（对应 checkpoint writer：增量并入九节模板）
// ============================================================================

function serializeDelta(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push(`[${msg.role === "user" ? "用户" : "助手"}]: ${block.text}`);
      } else if (block.type === "tool_use") {
        parts.push(
          `[工具调用 ${block.name}]: ${JSON.stringify(block.input).slice(0, 300)}`
        );
      } else if (block.content !== PRUNE_PLACEHOLDER) {
        parts.push(
          `[工具结果${block.is_error ? "（失败）" : ""}]: ${block.content.slice(0, 1500)}`
        );
      }
    }
  }
  return parts.join("\n\n");
}

async function updateCheckpoint(
  deps: CompactDeps,
  state: MimoState,
  messages: Message[]
): Promise<void> {
  const delta = messages.slice(state.coveredCount);
  if (delta.length === 0) return;

  let prompt = `<new-conversation>\n${serializeDelta(delta)}\n</new-conversation>\n\n`;
  if (state.checkpoint) {
    prompt += `<previous-checkpoint>\n${state.checkpoint}\n</previous-checkpoint>\n\n`;
    prompt +=
      "以上 <new-conversation> 是自上次检查点以来的新增对话，<previous-checkpoint> 是既有检查点。" +
      "把新信息并入检查点：保留仍然相关的既有内容，更新已变化的（§1/§2/§4 反映最新状态），" +
      "过时内容可删除。";
  } else {
    prompt +=
      "以上 <new-conversation> 是需要建立检查点的对话内容。请生成首份检查点。";
  }
  prompt += `\n\n严格按以下九节模板输出完整检查点（各节都要保留标题，空节写"（无）"；括号内是各节大致 token 预算，务必精炼）：\n\n${CHECKPOINT_SECTIONS}`;

  const response = await deps.client.streamMessage({
    system: CHECKPOINT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    tools: [],
    model: deps.config.model,
    maxTokens: CHECKPOINT_MAX_TOKENS,
    onEvent: deps.onEvent ?? (() => {}),
  });
  const text = response.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("检查点更新失败：模型未返回内容");
  state.checkpoint = text;
  state.coveredCount = messages.length;
}

// ============================================================================
// 尾窗边界（对应 computeBoundary + adjustBoundaryForApiInvariants）
// ============================================================================

export function computeTailStart(
  messages: Message[],
  tailMin: number = TAIL_MIN_TOKENS,
  tailMax: number = TAIL_MAX_TOKENS
): number {
  if (messages.length === 0) return 0;
  const lastAsst = messages.reduceRight(
    (found, _m, i) => (found >= 0 ? found : messages[i].role === "assistant" ? i : -1),
    -1
  );
  if (lastAsst <= 0) return Math.max(lastAsst, 0);

  let start = lastAsst - 1;
  const tokens = messages.map(estimateMessageTokens);
  let tailSum = 0;
  let textCount = 0;
  for (let i = start; i < messages.length; i++) {
    tailSum += tokens[i];
    if (containsText(messages[i])) textCount++;
  }
  // 天然尾窗已超上限：不前移边界（消息粒度截断会拆配对），软上限
  if (tailSum < tailMax) {
    while (
      start > 0 &&
      tailSum < tailMax &&
      (tailSum < tailMin || textCount < TAIL_MIN_TEXT_MESSAGES)
    ) {
      start--;
      tailSum += tokens[start];
      if (containsText(messages[start])) textCount++;
    }
  }
  // 配对安全：边界落在 tool_result 载体上时向旧侧扩，把配对的 tool_use 一并纳入
  while (start > 0 && containsToolResult(messages[start])) start--;
  return start;
}

// ============================================================================
// 重建（对应 renderRebuildContext + insertRebuildBoundary：本地完成，零 LLM 调用）
// ============================================================================

function renderRebuildCarrier(
  state: MimoState,
  messages: Message[],
  recentUserCap: number = RECENT_USER_CAP
): string {
  const lines: string[] = [];
  lines.push(
    "以下区块由会话记忆自动载入，已在你的上下文中，不要当作新输入逐条回应。"
  );
  lines.push("");
  lines.push("## 会话检查点");
  lines.push(state.checkpoint ?? "（无）");
  lines.push("");

  // 最近用户输入原文（FIFO，总预算 16K、单条 2K）：writer 摘要会转述丢锚点，
  // 原文保留精确的命令、标志与粘贴内容
  const entries: string[] = [];
  let remaining = recentUserCap;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isRealUserMessage(msg)) continue;
    const entry = truncateVerbatim(messageText(msg).trim(), RECENT_USER_PER_MSG);
    const cost = Math.ceil(entry.length / 4);
    if (remaining - cost < 0) break;
    entries.unshift(`- ${entry.replace(/\n/g, "\n  ")}`);
    remaining -= cost;
  }
  if (entries.length > 0) {
    lines.push("## 最近用户输入（原文）");
    lines.push(...entries);
    lines.push("");
  }

  lines.push(
    "本会话在触及检查点后从先前对话延续而来，上方的会话检查点覆盖了此前的对话内容。"
  );
  lines.push(
    "下方保留的最近消息是逐字原文的真实历史，不是伪造内容。请基于最新状态继续你的任务。"
  );
  lines.push(
    "直接继续工作。不要对这份记忆转储做出回应，不要复述，不要以「我将继续」之类开场。"
  );
  return lines.join("\n");
}

function rebuild(deps: CompactDeps, state: MimoState): void {
  const messages = deps.history.getMessages();
  // 小窗口时尾窗与原文预算按 usable 等比缩放，避免重建结果仍超 usable 反复触发
  const usable = usableTokens(deps.config.contextWindow);
  const tailMax = Math.min(TAIL_MAX_TOKENS, Math.floor(usable * 0.6));
  const tailMin = Math.min(TAIL_MIN_TOKENS, Math.floor(usable * 0.3));
  const recentUserCap = Math.min(RECENT_USER_CAP, Math.floor(usable * 0.25));
  const tailStart = computeTailStart(messages, tailMin, tailMax);
  const carrier: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `${SUMMARY_PREFIX}\n${renderRebuildCarrier(state, messages, recentUserCap)}`,
      },
    ],
  };
  deps.history.replaceAll([carrier, ...messages.slice(tailStart)]);
  state.coveredCount = 1;
  state.crossed.clear();
}

// ============================================================================
// 策略实现
// ============================================================================

async function doCompact(deps: CompactDeps): Promise<CompactResult> {
  const beforeTokens = deps.history.estimateTokens();
  const state = stateOf(deps.history);
  const contextWindow = deps.config.contextWindow;

  if (deps.history.getMessages().length === 0 || beforeTokens < 1000) {
    return {
      compacted: false,
      warning: TOO_SHORT_WARNING,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  // 1) prune：先无成本释放旧工具输出
  const pruned = pruneToolOutputs(deps.history);

  // 2) 检查点更新：把 watermark 之后的增量并入检查点（历史不改动）
  try {
    await updateCheckpoint(deps, state, deps.history.getMessages());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      compacted: false,
      warning: `压缩失败，已保留原历史：${message}`,
      beforeTokens,
      afterTokens: deps.history.estimateTokens(),
    };
  }

  // 标记当前已达的所有阈值档，避免同一档重复触发
  const tokensNow = deps.history.estimateTokens();
  for (const t of checkpointThresholds(contextWindow)) {
    if (tokensNow >= t) state.crossed.add(t);
  }

  // 3) 溢出才重建（本地、零 LLM 调用）；未溢出 = 纯后台检查点维护
  if (tokensNow >= usableTokens(contextWindow)) {
    rebuild(deps, state);
    return {
      compacted: true,
      beforeTokens,
      afterTokens: deps.history.estimateTokens(),
    };
  }

  return {
    compacted: false,
    notice:
      `已更新会话检查点（历史未改动${pruned > 0 ? `，另裁剪旧工具输出约 ${pruned} token` : ""}；` +
      "上下文耗尽时将从检查点即时重建）",
    beforeTokens,
    afterTokens: deps.history.estimateTokens(),
  };
}

/** mimo 策略：阈值阶梯检查点 + 溢出本地重建 + 工具输出裁剪 */
export const mimoStrategy: CompactionStrategy = {
  id: "mimo",
  label: "MiMo（检查点重建）",
  description:
    "移植自 MiMo-Code 的\"无限上下文\"机制：用量每跨一档阈值（大窗口最密每 5%）就把增量" +
    "并入结构化检查点（九节模板，历史不改动），真正溢出时零 LLM 调用本地即时重建" +
    "（检查点 + 最近用户输入原文 + 10-20K 配对安全尾窗）；检查点更新前先裁剪 2 回合外的" +
    "旧工具输出（保护最近 40K）。",
  shouldCompact(deps) {
    const tokens = deps.history.estimateTokens();
    const window = deps.config.contextWindow;
    if (tokens >= usableTokens(window)) return true;
    const state = states.get(deps.history);
    return (
      nextUncrossedThreshold(tokens, window, state?.crossed ?? new Set()) !==
      undefined
    );
  },
  compact: doCompact,
};
