import { spawnSync } from "node:child_process";
import { COMPACTION_STRATEGY_IDS } from "./agent/compaction/registry.js";

/** thinking 档位：就这四档，不多不少（DeepSeek Anthropic 端点 reasoning.effort） */
export const EFFORT_LEVELS = ["none", "low", "high", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface Config {
  apiKey: string;
  /** OAuth access token：设置时以 Authorization: Bearer 鉴权（apiKey 忽略），
   *  供 OAuth 型供应商（如 xAI/Grok 订阅）使用；CLI 环境变量路径不产生此字段 */
  authToken?: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
  /** 未设置 = 不传 reasoning 参数（端点默认 high） */
  effort?: EffortLevel;
  /** 压缩策略 id（见 agent/compaction/registry），未设置 = 默认策略 */
  compactionStrategy?: string;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_MODEL = "deepseek-v4-pro";

function defaultContextWindow(model: string): number {
  if (model.startsWith("deepseek-v4-")) return 1_000_000;
  return 200_000;
}

function checkRipgrep(): void {
  const result = spawnSync("rg", ["--version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error(
      "xharness 依赖 ripgrep (rg)，但未在 PATH 中找到。请先安装：brew install ripgrep"
    );
  }
}

export function loadConfig(): Config {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "缺少环境变量 ANTHROPIC_API_KEY。请设置后重试，例如：export ANTHROPIC_API_KEY=<你的 DeepSeek key>"
    );
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.XHARNESS_MODEL || DEFAULT_MODEL;

  let contextWindow = defaultContextWindow(model);
  const rawWindow = process.env.XHARNESS_CONTEXT_WINDOW;
  if (rawWindow) {
    const parsed = Number.parseInt(rawWindow, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `XHARNESS_CONTEXT_WINDOW 无效："${rawWindow}"，需要正整数`
      );
    }
    contextWindow = parsed;
  }

  let effort: EffortLevel | undefined;
  const rawEffort = process.env.XHARNESS_EFFORT;
  if (rawEffort) {
    if (!(EFFORT_LEVELS as readonly string[]).includes(rawEffort)) {
      throw new Error(
        `XHARNESS_EFFORT 无效："${rawEffort}"，可选档位：${EFFORT_LEVELS.join(" | ")}`
      );
    }
    effort = rawEffort as EffortLevel;
  }

  let compactionStrategy: string | undefined;
  const rawCompact = process.env.XHARNESS_COMPACT_STRATEGY;
  if (rawCompact) {
    if (!COMPACTION_STRATEGY_IDS.includes(rawCompact)) {
      throw new Error(
        `XHARNESS_COMPACT_STRATEGY 无效："${rawCompact}"，可选策略：${COMPACTION_STRATEGY_IDS.join(" | ")}`
      );
    }
    compactionStrategy = rawCompact;
  }

  checkRipgrep();

  return { apiKey, baseUrl, model, contextWindow, effort, compactionStrategy };
}
