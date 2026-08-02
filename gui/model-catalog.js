// 模型目录自动同步：运行时从 models.dev/api.json 拉取内置供应商的
// 模型列表 / 上下文窗口 / 分项定价（含分层），彻底摆脱手工维护。
// 思路来自 pi-mono 的 generate-models（它在构建期生成静态目录，我们改为
// 运行时拉取 + 本地缓存）：启动异步同步（24h TTL），失败静默回退缓存/种子，
// 永不阻塞、永不破坏离线可用性。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as store from "./store.js";

const CATALOG_URL = "https://models.dev/api.json";
const CACHE_FILE = join(store.DATA_DIR, "models-catalog.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

// 内置供应商 → models.dev 供应商 id 的映射；自定义供应商不参与自动同步
const MANAGED = { deepseek: "deepseek", grok: "xai" };

/** models.dev 的 cost 结构 → 我们的 pricing（美元/百万 token，含分层） */
function normalizePricing(cost) {
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") {
    return null;
  }
  const pricing = {
    input: cost.input,
    output: cost.output,
    ...(typeof cost.cache_read === "number" ? { cacheRead: cost.cache_read } : {}),
  };
  // 分层：{"tiers":[{input,output,cache_read,tier:{type:"context",size:200000}}]}
  // → [{inputTokensAbove, input, output, cacheRead}]，升序
  const tiers = (cost.tiers ?? [])
    .filter(
      (t) =>
        t?.tier?.type === "context" &&
        typeof t.tier.size === "number" &&
        typeof t.input === "number" &&
        typeof t.output === "number"
    )
    .map((t) => ({
      inputTokensAbove: t.tier.size,
      input: t.input,
      output: t.output,
      ...(typeof t.cache_read === "number" ? { cacheRead: t.cache_read } : {}),
    }))
    .sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
  if (tiers.length > 0) pricing.tiers = tiers;
  return pricing;
}

/** 目录中一家供应商的模型表 → 我们的 models 数组（过滤规则同 pi：仅工具可用的对话模型） */
export function normalizeProviderModels(catalogProvider) {
  const out = [];
  for (const [id, m] of Object.entries(catalogProvider?.models ?? {})) {
    if (m?.tool_call !== true) continue; // 图像/视频/嵌入等一律过滤
    const context = m?.limit?.context;
    if (typeof context !== "number" || context < 8_000) continue;
    const pricing = normalizePricing(m.cost);
    out.push({ id, contextWindow: context, ...(pricing ? { pricing } : {}) });
  }
  return out;
}

function readCache() {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (raw && typeof raw.fetchedAt === "number" && raw.providers) return raw;
  } catch {
    /* 无缓存/损坏 */
  }
  return null;
}

async function fetchCatalog() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(CATALOG_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`models.dev 返回 HTTP ${response.status}`);
    const data = await response.json();
    // 只缓存我们关心的供应商子集（全量目录数 MB，无谓占盘）
    const providers = {};
    for (const catalogId of Object.values(MANAGED)) {
      if (data[catalogId]) providers[catalogId] = { models: data[catalogId].models ?? {} };
    }
    const cache = { fetchedAt: Date.now(), providers };
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
    return cache;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 同步内置供应商的模型目录。返回 {synced, fetchedAt, changed, error?}。
 * - 缓存未过期且非 force：直接用缓存对齐（幂等，仅有差异才写 settings）；
 * - 拉取失败：回退缓存；连缓存都没有则保持种子数据，静默降级。
 */
export async function syncModelCatalog({ force = false } = {}) {
  let cache = readCache();
  let error;
  if (force || !cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
    try {
      cache = await fetchCatalog();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (!cache) return { synced: false, fetchedAt: null, changed: false, error };
    }
  }

  let changed = false;
  for (const [providerId, catalogId] of Object.entries(MANAGED)) {
    const models = normalizeProviderModels(cache.providers[catalogId]);
    if (models.length === 0) continue; // 目录异常时不清空既有列表
    if (store.updateProviderModels(providerId, models)) changed = true;
  }
  return { synced: true, fetchedAt: cache.fetchedAt, changed, ...(error ? { error } : {}) };
}

/** 上次同步时间（毫秒时间戳），无缓存为 null——GUI 展示用 */
export function lastSyncedAt() {
  return readCache()?.fetchedAt ?? null;
}
