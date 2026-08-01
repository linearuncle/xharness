import { spawnSync } from "node:child_process";

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
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

  checkRipgrep();

  return { apiKey, baseUrl, model, contextWindow };
}
