// 持久化：JSONL（append-only 事件日志），数据目录见 DATA_DIR
//   projects.jsonl        —— 每行 {op:"add"|"remove", dir, ts}
//   sessions/<id>.jsonl   —— 首行 {kind:"meta",...}；此后每行一个 block；
//                            标题/置顶经 {kind:"meta_update"} 行；/clear 经 {kind:"clear"} 行
//   settings.jsonl        —— 供应商 upsert/delete 事件（权限 600，key 明文，换 key 整文件重写）
// 全部只追加不重写；启动时重放重建内存态。
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync,
  readdirSync, existsSync, renameSync, rmSync, chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// 数据目录：macOS 惯例的应用数据位置（不用 app.getPath——本模块在 app.setName 前被 import）。
// 手填 API Key 以明文存于 settings.jsonl（权限 600）：不碰钥匙串（ad-hoc 签名下每次
// 重签都会触发授权弹框）；防同机其他用户靠文件权限。GUI 仅支持手动填写，不读环境变量。
const DIR =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "xharness")
    : join(homedir(), ".xharness", "gui");
export const DATA_DIR = DIR;
const SESS_DIR = join(DIR, "sessions");
const PROJECTS_FILE = join(DIR, "projects.jsonl");
const SETTINGS_FILE = join(DIR, "settings.jsonl");

let projects = []; // [{dir}]
let conversations = {}; // id -> {projectDir,title,pinned,createdAt,blocks}
let providers = []; // 模型供应商（settings.jsonl 重放）
let appearance = null; // 外观设置（settings.jsonl 重放；null = 默认）
let general = null; // 通用设置（settings.jsonl 重放；null = 默认）

const DEFAULT_GENERAL = {
  compactionStrategy: "classic",
  showSessionStats: true,
  disabledSkills: [], // 技能名列表；禁用只影响 GUI 会话装载，不改动技能文件
};

// 外观默认值：浅/深两套主题独立配置，mode 决定生效哪套（system 跟随系统）
export const DEFAULT_APPEARANCE = {
  mode: "system", // system | light | dark
  light: {
    preset: "default", accent: "#2563eb", background: "#ffffff", foreground: "#1a1a1a",
    uiFont: "", codeFont: "", translucentSidebar: false, contrast: 50,
  },
  dark: {
    preset: "default", accent: "#339cff", background: "#181818", foreground: "#ffffff",
    uiFont: "", codeFont: "", translucentSidebar: false, contrast: 50,
  },
};

const DEFAULT_PROVIDER = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic",
  apiFormat: "anthropic",
  apiKey: "",
  enabled: true,
  builtin: true,
  models: [
    { id: "deepseek-v4-flash", contextWindow: 1_000_000 },
    { id: "deepseek-v4-pro", contextWindow: 1_000_000 },
  ],
};

// Grok（xAI）内置供应商：OAuth 设备码登录（SuperGrok / X Premium 订阅），
// 不走手填 API Key；api.x.ai 原生支持 Anthropic Messages 格式（实测 /v1/messages）。
// oauth 凭据 {access, refresh, expires} 与 apiKey 同等敏感，明文存 settings.jsonl（权限 600）。
const DEFAULT_GROK_PROVIDER = {
  id: "grok",
  name: "Grok",
  baseUrl: "https://api.x.ai",
  apiFormat: "anthropic",
  authType: "oauth-xai",
  apiKey: "",
  oauth: null,
  enabled: true,
  builtin: true,
  // 模型参数与定价以 models.dev/api.json 为准（2026-08 校对）
  models: [
    { id: "grok-4.3", contextWindow: 1_000_000, pricing: { input: 1.25, output: 2.5, cacheRead: 0.2 } },
    { id: "grok-4.5", contextWindow: 500_000, pricing: { input: 2, output: 6, cacheRead: 0.3 } },
    { id: "grok-build-0.1", contextWindow: 256_000, pricing: { input: 1, output: 2, cacheRead: 0.2 } },
  ],
};

const line = (obj) => JSON.stringify(obj) + "\n";

function appendLine(file, obj) {
  try {
    appendFileSync(file, line(obj));
  } catch (err) {
    console.error("store append failed:", err.message);
  }
}

function readLines(file) {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const sessFile = (id) => join(SESS_DIR, `${id}.jsonl`);

function replaySession(id) {
  const rows = readLines(sessFile(id));
  if (!rows.length || rows[0].kind !== "meta") return null;
  const meta = rows[0];
  const c = {
    projectDir: meta.projectDir,
    title: meta.title ?? "新对话",
    pinned: false,
    createdAt: meta.createdAt ?? 0,
    blocks: [],
  };
  for (const r of rows.slice(1)) {
    if (r.kind === "meta_update") {
      if (r.title !== undefined) c.title = r.title;
      if (r.pinned !== undefined) c.pinned = r.pinned;
    } else if (r.kind === "clear") {
      c.blocks = [];
    } else {
      c.blocks.push(r);
    }
  }
  return c;
}

export function load() {
  mkdirSync(SESS_DIR, { recursive: true });

  projects = [];
  for (const r of readLines(PROJECTS_FILE)) {
    if (r.op === "add" && r.dir && !projects.some((p) => p.dir === r.dir))
      projects.push({ dir: r.dir });
    if (r.op === "remove")
      projects = projects.filter((p) => p.dir !== r.dir);
  }

  conversations = {};
  let files = [];
  try {
    files = readdirSync(SESS_DIR).filter((f) => f.endsWith(".jsonl"));
  } catch { /* 目录不存在等 */ }
  for (const f of files) {
    const id = f.slice(0, -".jsonl".length);
    const c = replaySession(id);
    if (c) conversations[id] = c;
  }

  // settings.jsonl 重放：{op:"upsert",provider} / {op:"delete",id} / {op:"appearance",appearance}
  //                     / {op:"general",general}
  providers = [];
  appearance = null;
  general = null;
  for (const r of readLines(SETTINGS_FILE)) {
    if (r.op === "upsert" && r.provider?.id) {
      const i = providers.findIndex((p) => p.id === r.provider.id);
      if (i >= 0) providers[i] = r.provider;
      else providers.push(r.provider);
    } else if (r.op === "delete") {
      providers = providers.filter((p) => p.id !== r.id);
    } else if (r.op === "appearance" && r.appearance) {
      appearance = r.appearance;
    } else if (r.op === "general" && r.general) {
      general = r.general;
    }
  }
  if (!providers.some((p) => p.id === "deepseek")) {
    providers.unshift({ ...DEFAULT_PROVIDER });
    appendLine(SETTINGS_FILE, { op: "upsert", provider: DEFAULT_PROVIDER, ts: Date.now() });
  }
  if (!providers.some((p) => p.id === "grok")) {
    providers.push({ ...DEFAULT_GROK_PROVIDER });
    appendLine(SETTINGS_FILE, { op: "upsert", provider: DEFAULT_GROK_PROVIDER, ts: Date.now() });
  }

  try { chmodSync(SETTINGS_FILE, 0o600); } catch { /* 文件可能不存在 */ }

  return { projects, conversations };
}

// 以当前内存态整文件重写（迁移/换 key 时用，日常仍是追加）
function rewriteSettings() {
  let out = "";
  for (const p of providers) {
    out += line({ op: "upsert", provider: p, ts: Date.now() });
  }
  if (appearance) out += line({ op: "appearance", appearance, ts: Date.now() });
  if (general) out += line({ op: "general", general, ts: Date.now() });
  writeFileSync(SETTINGS_FILE, out);
  try { chmodSync(SETTINGS_FILE, 0o600); } catch { /* noop */ }
}

// 深合并默认值：老数据缺字段时用默认补齐（不写迁移，读取时兜底）
export function getAppearance() {
  const a = appearance ?? {};
  return {
    mode: a.mode ?? DEFAULT_APPEARANCE.mode,
    light: { ...DEFAULT_APPEARANCE.light, ...(a.light ?? {}) },
    dark: { ...DEFAULT_APPEARANCE.dark, ...(a.dark ?? {}) },
  };
}

export function setAppearance(a) {
  appearance = {
    mode: ["system", "light", "dark"].includes(a?.mode) ? a.mode : "system",
    light: { ...DEFAULT_APPEARANCE.light, ...(a?.light ?? {}) },
    dark: { ...DEFAULT_APPEARANCE.dark, ...(a?.dark ?? {}) },
  };
  appendLine(SETTINGS_FILE, { op: "appearance", appearance, ts: Date.now() });
}

export function getGeneral() {
  return { ...DEFAULT_GENERAL, ...(general ?? {}) };
}

export function setGeneral(patch) {
  general = { ...getGeneral(), ...(patch ?? {}) };
  appendLine(SETTINGS_FILE, { op: "general", general, ts: Date.now() });
}

// 取 key（仅主进程内部使用，不经 IPC）
export function getProviderKey(id) {
  const p = providers.find((x) => x.id === id);
  return p?.apiKey ?? "";
}

export function getProviders() {
  return providers;
}

// 给渲染进程的脱敏视图：key 与 oauth 凭据不经 IPC 下发
export function getProvidersSafe() {
  return providers.map((p) => {
    const { apiKey, oauth, ...rest } = p;
    return { ...rest, apiKey: "", hasKey: !!apiKey || !!oauth?.refresh };
  });
}

export function upsertProvider(p) {
  const clean = { ...p };
  delete clean.keyMode; // 已废弃：GUI 仅手动填写，不再支持环境变量模式
  delete clean.hasKey;
  // 表单会回填已保存 key；apiKey 以提交值为准（含清空）
  if (typeof clean.apiKey !== "string") clean.apiKey = "";
  const i = providers.findIndex((x) => x.id === clean.id);
  // 表单不携带 oauth 凭据：保存时沿用已存值，避免一次普通保存把登录态清掉
  if (i >= 0 && clean.oauth === undefined && providers[i].oauth) {
    clean.oauth = providers[i].oauth;
  }
  if (i >= 0) providers[i] = clean;
  else providers.push(clean);
  // 换 key 属敏感变更：整文件重写，不在历史行里残留旧 key
  rewriteSettings();
}

/** 模型目录自动同步专用：整表替换指定供应商的 models，有实际差异才落盘。
 *  返回是否发生了变更。仅内置供应商由 model-catalog.js 调用。 */
export function updateProviderModels(id, models) {
  const p = providers.find((x) => x.id === id);
  if (!p) return false;
  if (JSON.stringify(p.models) === JSON.stringify(models)) return false;
  p.models = models;
  rewriteSettings();
  return true;
}

// ---------- OAuth 凭据（主进程内部使用，不经 IPC 下发明文） ----------

export function getProviderOAuth(id) {
  return providers.find((x) => x.id === id)?.oauth ?? null;
}

export function setProviderOAuth(id, credential) {
  const p = providers.find((x) => x.id === id);
  if (!p) return;
  p.oauth = credential;
  // 凭据变更与换 key 同级敏感：整文件重写
  rewriteSettings();
}

export function clearProviderOAuth(id) {
  setProviderOAuth(id, null);
}

export function deleteProvider(id) {
  const p = providers.find((x) => x.id === id);
  if (!p || p.builtin) return; // 内置供应商不可删
  providers = providers.filter((x) => x.id !== id);
  rewriteSettings(); // 删除供应商时连历史密文一并清掉
}

export function addProject(dir) {
  if (!projects.some((p) => p.dir === dir)) {
    projects.push({ dir });
    appendLine(PROJECTS_FILE, { op: "add", dir, ts: Date.now() });
  }
}

export function newConversation(projectDir) {
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const createdAt = Date.now();
  conversations[id] = {
    projectDir, title: "新对话", pinned: false, createdAt, blocks: [],
  };
  writeFileSync(sessFile(id), line({ kind: "meta", id, projectDir, title: "新对话", createdAt }));
  return id;
}

export function getConversation(id) {
  return conversations[id] ?? null;
}

export function setTitle(id, title) {
  const c = conversations[id];
  if (c && c.title === "新对话") {
    c.title = title;
    appendLine(sessFile(id), { kind: "meta_update", title, ts: Date.now() });
    return true;
  }
  return false;
}

export function setPinned(id, pinned) {
  const c = conversations[id];
  if (c) {
    c.pinned = pinned;
    appendLine(sessFile(id), { kind: "meta_update", pinned, ts: Date.now() });
  }
}

export function deleteConversation(id) {
  delete conversations[id];
  try { rmSync(sessFile(id)); } catch { /* 已不存在 */ }
}

export function appendBlock(id, block) {
  const c = conversations[id];
  if (c) {
    c.blocks.push(block);
    appendLine(sessFile(id), { ...block, ts: Date.now() });
  }
}

export function clearBlocks(id) {
  const c = conversations[id];
  if (c) {
    c.blocks = [];
    appendLine(sessFile(id), { kind: "clear", ts: Date.now() });
  }
}

export function sidebarData() {
  const convs = Object.entries(conversations).map(([id, c]) => ({
    id,
    title: c.title,
    pinned: !!c.pinned,
    projectDir: c.projectDir,
    createdAt: c.createdAt,
  }));
  convs.sort((a, b) => a.createdAt - b.createdAt);
  return {
    pinned: convs.filter((c) => c.pinned),
    projects: projects.map((p) => ({
      dir: p.dir,
      name: basename(p.dir),
      conversations: convs.filter((c) => c.projectDir === p.dir),
    })),
  };
}
