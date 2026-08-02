import { classicStrategy } from "./classic.js";
import { grokStrategy } from "./grok.js";
import { mimoStrategy } from "./mimo.js";
import { piStrategy } from "./pi.js";
import type { CompactionStrategy } from "./types.js";

/** 全部策略：新增算法在此追加注册即可，禁止在调用方按策略 id 写特殊分支 */
const STRATEGIES: readonly CompactionStrategy[] = [
  classicStrategy,
  piStrategy,
  grokStrategy,
  mimoStrategy,
];

export const DEFAULT_COMPACTION_STRATEGY_ID = classicStrategy.id;

export const COMPACTION_STRATEGY_IDS: readonly string[] = STRATEGIES.map(
  (s) => s.id
);

/** 未指定或未知 id 时回退默认策略（配置容错，不抛错） */
export function getCompactionStrategy(id?: string): CompactionStrategy {
  return STRATEGIES.find((s) => s.id === id) ?? classicStrategy;
}

/** GUI 设置下拉用的元信息列表 */
export function listCompactionStrategies(): Array<{
  id: string;
  label: string;
  description: string;
}> {
  return STRATEGIES.map(({ id, label, description }) => ({
    id,
    label,
    description,
  }));
}
