/**
 * 压缩统一入口：按 config.compactionStrategy 分发到具体策略。
 * 自动（maybeCompact）与手动（forceCompact）共用策略的 compact 实现，
 * 差别仅在自动入口先过策略自己的触发判断。
 */
import { getCompactionStrategy } from "./registry.js";
import type { CompactDeps, CompactResult } from "./types.js";

export { KEEP_RECENT_MESSAGES } from "./classic.js";
export {
  COMPACTION_STRATEGY_IDS,
  DEFAULT_COMPACTION_STRATEGY_ID,
  getCompactionStrategy,
  listCompactionStrategies,
} from "./registry.js";
export { SUMMARY_PREFIX } from "./types.js";
export type {
  CompactDeps,
  CompactResult,
  CompactionStrategy,
} from "./types.js";

/** 自动压缩入口：触发条件由所选策略决定，未触发则无操作 */
export async function maybeCompact(deps: CompactDeps): Promise<CompactResult> {
  const strategy = getCompactionStrategy(deps.config.compactionStrategy);
  if (!strategy.shouldCompact(deps)) {
    const tokens = deps.history.estimateTokens();
    return { compacted: false, beforeTokens: tokens, afterTokens: tokens };
  }
  return strategy.compact(deps);
}

/** 手动压缩入口（/compact）：无条件执行所选策略 */
export async function forceCompact(deps: CompactDeps): Promise<CompactResult> {
  return getCompactionStrategy(deps.config.compactionStrategy).compact(deps);
}
