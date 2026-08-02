import type { ApiClient } from "../../api/client.js";
import type { Config } from "../../config.js";
import type { History } from "../../session/history.js";
import type { AgentEvent } from "../../types/messages.js";

/** 摘要注入消息的统一前缀：所有策略共用，策略间切换时也能识别既有摘要 */
export const SUMMARY_PREFIX = "[历史摘要]";

export interface CompactDeps {
  history: History;
  client: ApiClient;
  config: Config;
  system?: string;
  /** 摘要调用产生的领域事件（如 usage）回传口；未设则丢弃 */
  onEvent?: (event: AgentEvent) => void;
}

export interface CompactResult {
  compacted: boolean;
  warning?: string;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * 可插拔压缩策略。新增算法只需实现本接口并在 registry 注册，
 * 调用方（CLI/GUI）经 config.compactionStrategy 选择，不感知具体算法。
 */
export interface CompactionStrategy {
  id: string;
  /** 展示名（GUI 设置下拉用） */
  label: string;
  description: string;
  /** 自动压缩触发判断；手动 /compact 不经此判断，无条件执行 compact */
  shouldCompact(deps: CompactDeps): boolean;
  /** 执行压缩：就地改写 deps.history；失败须保留原历史并以 warning 返回 */
  compact(deps: CompactDeps): Promise<CompactResult>;
}
