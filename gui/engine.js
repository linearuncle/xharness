// 引擎层：把 xharness（../dist）包装成 GUI 会话。
// 每个会话持有独立的 History/Registry/Config（模型与推理强度可覆盖）。
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import { refreshAccessToken } from "./oauth-xai.js";
import { createApiClient } from "../dist/api/client.js";
import { createDefaultRegistry } from "../dist/tools/registry.js";
import {
  buildSystemPrompt,
  collectEnv,
  loadProjectInstructions,
} from "../dist/agent/prompts.js";
import { runTurn } from "../dist/agent/loop.js";
import { maybeCompact, forceCompact } from "../dist/agent/compaction/index.js";
export { listCompactionStrategies } from "../dist/agent/compaction/registry.js";
import { History } from "../dist/session/history.js";
import { loadSkills } from "../dist/skills/loader.js";
import { createSkillTool } from "../dist/tools/skill.js";
import { createTodoWriteTool } from "../dist/tools/todoWrite.js";
import { dispatchSlash } from "../dist/ui/slashCommands.js";
import { loadPlugins } from "../dist/plugins/loader.js";
import { createPreToolUseHook } from "../dist/plugins/hooks.js";
import { ensureDefaultPlugins } from "../dist/plugins/install.js";

const here = dirname(fileURLToPath(import.meta.url));

export function initEngine() {
  const r = spawnSync("rg", ["--version"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    throw new Error(
      "xharness 依赖 ripgrep (rg)，但未在 PATH 中找到。请先安装：brew install ripgrep"
    );
  }
  // 内置插件首启种子安装（dev 与打包版布局一致：../plugins）；失败仅警告不阻断
  ensureDefaultPlugins({ bundledRoot: join(here, "..", "plugins") });
}

/** 安装/新会话默认：flash + 高推理；用户改过的会话内选择优先（见 setModelChoice / setEffort） */
export const DEFAULT_MODEL_ID = "deepseek-v4-flash";
export const DEFAULT_EFFORT = "high";

export const EFFORTS = [
  { value: "", label: "默认(高)" },
  { value: "none", label: "关闭" },
  { value: "low", label: "低" },
  { value: "high", label: "高" },
  { value: "max", label: "Max" },
];

// 内置模型缺省定价（美元/百万 token，官方价 2026-08）；
// 自定义模型可在模型配置里填 pricing 覆盖；无定价则费用不累计、不显示
const DEFAULT_MODEL_PRICING = {
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028 },
  "deepseek-v4-pro": { input: 0.435, output: 0.87, cacheRead: 0.003625 },
  "grok-4.3": { input: 1.25, output: 2.5, cacheRead: 0.2 },
  "grok-4.5": { input: 2, output: 6, cacheRead: 0.3 },
  "grok-build-0.1": { input: 1, output: 2, cacheRead: 0.2 },
};

function emptyStats() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    cost: 0, cacheHitRate: null, contextTokens: 0, speed: null,
  };
}

// usage 领域事件 → 会话累计统计（费用按定价；缓存写按未命中输入价计，DeepSeek 语义）
function applyUsage(s, cfg, ev) {
  const u = ev.usage;
  const st = s.stats;
  st.input += u.inputTokens;
  st.output += u.outputTokens;
  st.cacheRead += u.cacheReadTokens;
  st.cacheWrite += u.cacheWriteTokens;
  const p = cfg.pricing;
  if (p) {
    st.cost +=
      ((u.inputTokens + u.cacheWriteTokens) * p.input +
        u.cacheReadTokens * (p.cacheRead ?? p.input) +
        u.outputTokens * p.output) / 1e6;
  }
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  if (prompt > 0) st.cacheHitRate = (u.cacheReadTokens / prompt) * 100;
  st.contextTokens = prompt + u.outputTokens;
  if (ev.durationMs > 0 && u.outputTokens > 0) {
    st.speed = u.outputTokens / (ev.durationMs / 1000);
  }
}

function statsEvent(s, cfg) {
  return {
    type: "stats",
    stats: {
      ...s.stats,
      hasPricing: !!cfg.pricing,
      contextWindow: cfg.contextWindow,
      percent: cfg.contextWindow
        ? (s.stats.contextTokens / cfg.contextWindow) * 100
        : null,
    },
  };
}

function enabledProviders() {
  return store.getProviders().filter((p) => p.enabled && p.models?.length);
}

export function defaultChoice() {
  const p = enabledProviders()[0];
  if (!p) return { providerId: null, model: null, effort: DEFAULT_EFFORT };
  const preferred = p.models.find((m) => m.id === DEFAULT_MODEL_ID);
  return {
    providerId: p.id,
    model: preferred?.id ?? p.models[0].id,
    effort: DEFAULT_EFFORT,
  };
}

function resolveKey(provider) {
  const key = store.getProviderKey(provider.id);
  if (key) return key;
  throw new Error(`供应商「${provider.name}」未填写 API Key，请到设置中填写`);
}

// OAuth 型供应商：请求前取新鲜 access token（提前 5 分钟过期即刷新并落盘）
async function resolveAuth(provider) {
  if (provider.authType === "oauth-xai") {
    const cred = store.getProviderOAuth(provider.id);
    if (!cred?.refresh) {
      throw new Error(`供应商「${provider.name}」未登录，请到设置中使用 Grok 账号登录`);
    }
    if (cred.expires > Date.now()) return { apiKey: "", authToken: cred.access };
    let next;
    try {
      next = await refreshAccessToken(cred.refresh);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Grok 登录已失效（${msg}），请到设置中重新登录`);
    }
    store.setProviderOAuth(provider.id, next);
    return { apiKey: "", authToken: next.access };
  }
  return { apiKey: resolveKey(provider) };
}

const sessions = new Map();

function seedHistory(history, blocks) {
  for (const b of blocks) {
    if (b.kind === "user") {
      history.push({ role: "user", content: [{ type: "text", text: b.text }] });
    } else if (b.kind === "assistant" && b.text) {
      history.push({
        role: "assistant",
        content: [{ type: "text", text: b.text }],
      });
    }
  }
}

export function getSession(convId, projectDir, savedBlocks) {
  let s = sessions.get(convId);
  if (s) return s;

  const skills = loadSkills({ cwd: projectDir });
  const registry = createDefaultRegistry();
  const todoStore = { todos: [] };
  const choice = defaultChoice();

  s = {
    convId,
    projectDir,
    providerId: choice.providerId,
    model: choice.model,
    effort: choice.effort ?? DEFAULT_EFFORT,
    history: new History(),
    registry,
    skills,
    todoStore,
    stats: emptyStats(),
    running: false,
    abort: null,
    pendingAsk: null,
    emit: () => {},
  };

  registry.register(
    createTodoWriteTool(todoStore, (todos) =>
      s.emit({ type: "todos", todos })
    )
  );
  registry.register(createAskTool(s));
  if (skills.length > 0) registry.register(createSkillTool(skills));

  if (savedBlocks?.length) seedHistory(s.history, savedBlocks);
  sessions.set(convId, s);
  return s;
}

function createAskTool(s) {
  return {
    name: "AskUserQuestion",
    description:
      "Ask the user a multiple-choice question when you need a decision you cannot make yourself. " +
      "Provide 2-4 options, each with a short label and a one-line description. " +
      "The user may also type a free-form answer. Blocks until the user responds.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask." },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              description: { type: "string" },
            },
            required: ["label", "description"],
          },
        },
      },
      required: ["question", "options"],
    },
    async execute(input, ctx) {
      const question = typeof input?.question === "string" ? input.question : "";
      const options = Array.isArray(input?.options) ? input.options : [];
      if (!question || options.length < 2 || options.length > 4) {
        return {
          content: "AskUserQuestion: question 必填，options 须为 2-4 项",
          isError: true,
        };
      }
      return await new Promise((resolve) => {
        const onAbort = () =>
          finish({ content: "[未作答——回合被中断]", isError: true });
        const finish = (result) => {
          ctx?.signal?.removeEventListener("abort", onAbort);
          s.pendingAsk = null;
          resolve(result);
        };
        if (ctx?.signal?.aborted) return onAbort();
        ctx?.signal?.addEventListener("abort", onAbort, { once: true });
        s.pendingAsk = (answer) => {
          const picked = options.find((o) => o.label === answer);
          finish({
            content: picked ? `用户选择: ${picked.label}` : `用户输入: ${answer}`,
          });
        };
        s.emit({ type: "ask", question, options });
      });
    },
  };
}

// 不含鉴权的会话配置（同步）：sessionMeta/统计等只读场景用
function configMeta(s) {
  const provider = store.getProviders().find((p) => p.id === s.providerId);
  if (!provider) throw new Error("未找到可用的模型供应商，请到设置中配置");
  const model = provider.models.find((m) => m.id === s.model) ?? provider.models[0];
  if (!model) throw new Error(`供应商「${provider.name}」未配置任何模型`);
  return {
    provider,
    apiKey: "",
    baseUrl: provider.baseUrl,
    model: model.id,
    contextWindow: model.contextWindow || 200_000,
    // 空/未设 → 产品默认 high；"none" 为合法档位须原样透传
    effort: s.effort || DEFAULT_EFFORT,
    // 全局设置：未知/未设 id 由 registry 回退默认策略
    compactionStrategy: store.getGeneral().compactionStrategy,
    // 模型配置里的 pricing 优先，内置模型回退默认价；无定价 = 不计费用
    pricing: model.pricing ?? DEFAULT_MODEL_PRICING[model.id] ?? null,
  };
}

// 含鉴权的请求配置（异步）：OAuth 供应商可能需要刷新 token
async function config(s) {
  const meta = configMeta(s);
  const auth = await resolveAuth(meta.provider);
  const { provider, ...cfg } = meta;
  return { ...cfg, ...auth };
}

function systemPrompt(s) {
  return buildSystemPrompt({
    ...collectEnv(s.projectDir),
    projectInstructions: loadProjectInstructions(s.projectDir),
    skillSummaries: s.skills.map(({ name, description }) => ({ name, description })),
  });
}

export function answer(convId, text) {
  const s = sessions.get(convId);
  if (s?.pendingAsk) s.pendingAsk(text);
}

export function stop(convId) {
  const s = sessions.get(convId);
  if (s?.abort) s.abort.abort();
}

export function setModelChoice(convId, providerId, model) {
  const s = sessions.get(convId);
  if (s) {
    s.providerId = providerId;
    s.model = model;
  }
}

export function setEffort(convId, effort) {
  const s = sessions.get(convId);
  if (!s) return;
  // ""（默认(高)）与未设都落成产品默认 high；用户选 none/low/high/max 原样保留
  s.effort = effort || DEFAULT_EFFORT;
}

export function sessionMeta(convId) {
  const s = sessions.get(convId);
  if (s) {
    let stats = null;
    try {
      stats = statsEvent(s, configMeta(s)).stats;
    } catch {
      // 供应商/Key 未配置时无法取窗口与定价，统计留空
    }
    return {
      providerId: s.providerId,
      model: s.model,
      effort: s.effort || DEFAULT_EFFORT,
      stats,
    };
  }
  const d = defaultChoice();
  return {
    providerId: d.providerId,
    model: d.model,
    effort: d.effort || DEFAULT_EFFORT,
  };
}

export function listSkills(projectDir) {
  return loadSkills({ cwd: projectDir }).map(({ name, description }) => ({
    name,
    description,
  }));
}

export function projectContext(projectDir) {
  const run = (args) => {
    const r = spawnSync("git", args, { cwd: projectDir, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = run(["status", "--short"]);
  return {
    folder: basename(projectDir),
    branch,
    changes: status ? status.split("\n").filter(Boolean) : [],
  };
}

export function searchFiles(projectDir, query) {
  const r = spawnSync("rg", ["--files"], {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0 && r.status !== 1) return [];
  const q = query.toLowerCase();
  return (r.stdout || "")
    .split("\n")
    .filter((f) => f && f.toLowerCase().includes(q))
    .slice(0, 8);
}

// 附件 → 前置一条含 image/文本块的 user 消息（Anthropic 格式允许连续 user 消息）
function pushAttachments(history, attachments) {
  const blocks = [];
  for (const a of attachments ?? []) {
    if (a.kind === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: a.mediaType, data: a.base64 },
      });
    } else if (a.kind === "text") {
      blocks.push({ type: "text", text: `[附件 ${a.name}]\n${a.text}` });
    }
  }
  if (blocks.length) history.push({ role: "user", content: blocks });
}

// 发送一条用户输入。事件经 s.emit 流出（含合成事件 notice/ask/todos）。
export async function send(convId, projectDir, text, savedBlocks, emit, attachments) {
  const s = getSession(convId, projectDir, savedBlocks);
  s.emit = emit;
  if (s.running) {
    emit({ type: "notice", text: "当前回合仍在进行中" });
    return;
  }

  // 工具的相对路径与 Bash cwd 必须跟随会话的项目目录，
  // 否则继承 Electron 进程启动目录会把模型带偏（曾导致相对路径读文件失败）
  try {
    process.chdir(projectDir);
  } catch {
    emit({ type: "notice", text: `[警告] 项目目录不可用: ${projectDir}` });
  }

  // 斜杠命令（GUI 支持 /compact /clear 与技能名；其余内置在 GUI 中无意义）
  let turnInput = text;
  if (text.startsWith("/")) {
    const d = dispatchSlash(text, s.skills);
    if (d.kind === "builtin") {
      try {
        if (d.command === "compact") {
          const cfg = await config(s);
          const r = await forceCompact({
            history: s.history,
            client: createApiClient(cfg),
            config: cfg,
            onEvent: (ev) => {
              if (ev.type === "usage") {
                applyUsage(s, cfg, ev);
                emit(statsEvent(s, cfg));
              }
            },
          });
          if (r.compacted) {
            s.stats.contextTokens = s.history.estimateTokens();
            emit(statsEvent(s, cfg));
          }
          emit({
            type: "notice",
            text: r.compacted
              ? `已压缩：估算 token ${r.beforeTokens} → ${r.afterTokens}`
              : (r.warning ?? r.notice ?? "会话历史太短，无需压缩"),
          });
        } else if (d.command === "clear") {
          s.history = new History();
          s.todoStore.todos = [];
          // 上下文清零；累计 token/费用是已发生的会话开销，保留
          s.stats.contextTokens = 0;
          s.stats.speed = null;
          s.stats.cacheHitRate = null;
          try {
            emit(statsEvent(s, configMeta(s)));
          } catch {
            // 供应商未配置时跳过统计刷新
          }
          emit({ type: "cleared" });
        } else {
          emit({ type: "notice", text: `GUI 暂不支持 /${d.command}` });
        }
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      emit({ type: "turn_end", reason: "end_turn" });
      return;
    }
    if (d.kind === "skill") {
      turnInput = d.turn;
      emit({ type: "notice", text: `[触发技能 ${d.name}]` });
    }
    // unknown 斜杠按普通文本发送
  }

  s.running = true;
  s.abort = new AbortController();
  let cfg, client;
  try {
    cfg = await config(s);
    client = createApiClient(cfg);
  } catch (err) {
    s.running = false;
    s.abort = null;
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    emit({ type: "turn_end", reason: "end_turn" });
    return;
  }

  // usage 领域事件在此拦截聚合为会话统计，其余事件原样透传给渲染层
  const onEvent = (ev) => {
    if (ev.type === "usage") {
      applyUsage(s, cfg, ev);
      emit(statsEvent(s, cfg));
      return;
    }
    emit(ev);
  };

  try {
    const r = await maybeCompact({
      history: s.history,
      client,
      config: cfg,
      onEvent,
    });
    if (r.compacted) {
      s.stats.contextTokens = s.history.estimateTokens();
      emit(statsEvent(s, cfg));
      emit({
        type: "notice",
        text: `历史接近上下文窗口上限，已自动压缩：${r.beforeTokens} → ${r.afterTokens}`,
      });
    } else if (r.warning) {
      emit({ type: "notice", text: `[压缩警告] ${r.warning}` });
    } else if (r.notice) {
      emit({ type: "notice", text: r.notice });
    }
    pushAttachments(s.history, attachments);
    // 每回合重新装载插件：设置页的增删改/启停即时生效，无需重启会话
    const preToolUse = createPreToolUseHook(
      loadPlugins({
        cwd: projectDir,
        warn: (m) => emit({ type: "notice", text: m }),
      })
    );
    await runTurn({
      userInput: turnInput,
      history: s.history,
      registry: s.registry,
      client,
      config: cfg,
      system: systemPrompt(s),
      signal: s.abort.signal,
      preToolUse,
      onEvent,
    });
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    emit({ type: "turn_end", reason: "end_turn" });
  } finally {
    s.running = false;
    s.abort = null;
    s.pendingAsk = null;
  }
}
