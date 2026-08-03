// 持久化：SQLite（node:sqlite，Node/Electron 内置，零新增依赖），单库文件 xharness.db。
//   projects 表      —— (dir PK, added_at)；add 去重，最新添加靠前
//   conversations 表 —— 会话 meta（标题/置顶经 UPDATE；/clear 只推进 cleared_seq 水位，
//                        旧 blocks 行保留在库里，与原 JSONL「日志仍可考古」语义一致）
//   blocks 表        —— (conv_id, seq) 聚簇主键（WITHOUT ROWID），data 为 block JSON（含 ts）
//   providers 表     —— (id PK, pos, data JSON)；key/oauth 明文，写即覆盖（无历史残留）
//   kv 表            —— appearance / general / modelsCatalog 等单行 JSON，写即覆盖
//   attachments 表   —— 附件 BLOB（paste 图片、选取的文件），按文件名取
// 写路径：内存镜像 + 同步写穿（写失败仅打日志，内存优先，与原 append 失败策略一致）；
// 启动时 load() 重放 meta，blocks 按会话首次访问时懒加载。
// 详细架构见 docs/storage-sqlite.md。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// 数据目录：macOS 惯例的应用数据位置（不用 app.getPath——本模块在 app.setName 前被 import）。
// 手填 API Key 以明文存于 xharness.db（权限 600）：不碰钥匙串（ad-hoc 签名下每次
// 重签都会触发授权弹框）；防同机其他用户靠文件权限。GUI 仅支持手动填写，不读环境变量。
// XH_DATA_DIR：并发测试/多实例隔离用，指定后全部持久化落到该目录（见 docs/cdp-testing.md）。
const DIR =
  process.env.XH_DATA_DIR ||
  (process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "xharness")
    : join(homedir(), ".xharness", "gui"));
export const DATA_DIR = DIR;
const DB_FILE = join(DIR, "xharness.db");

let db = null;

let projects = []; // [{dir}]
let conversations = {}; // id -> {projectDir,title,createdAt,updatedAt,blocks,_loaded,_hiSeq,_clearedSeq}
let providers = []; // 模型供应商（providers 表重放）
let appearance = null; // 外观设置（kv 表单行；null = 默认）
let general = null; // 通用设置（kv 表单行；null = 默认）

const DEFAULT_GENERAL = {
  compactionStrategy: "classic",
  showSessionStats: true,
  disabledSkills: [], // 技能名列表；禁用只影响 GUI 会话装载，不改动技能文件
  // 最近一次会话模型选择 {providerId, model, effort}：作为新会话默认（记住最近一次选择），
  // null = 从未用过，回落安装默认 flash + high。经 setGeneral 深合并
  lastChoice: null,
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
// 不走手填 API Key；grok 模型只支持 OpenAI Response API（/v1/responses）。
// oauth 凭据 {access, refresh, expires} 与 apiKey 同等敏感，明文存 providers 表（库文件权限 600）。
const DEFAULT_GROK_PROVIDER = {
  id: "grok",
  name: "Grok",
  baseUrl: "https://api.x.ai",
  apiFormat: "openai-responses",
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

// ---------- DB 基础设施 ----------

// 写失败仅打日志、内存优先（沿用原 JSONL append 失败策略，避免一次磁盘故障打挂界面）
function safe(op, fn) {
  try {
    return fn();
  } catch (err) {
    console.error(`store ${op} failed:`, err.message);
    return undefined;
  }
}

const stmts = {}; // 预编译语句缓存（prepare 一次，全程复用）
function stmt(key, sql) {
  return (stmts[key] ??= db.prepare(sql));
}

// 含密钥/oauth 明文：库文件 600 防同机其他用户。WAL 侧车（-wal/-shm）在首次写入时
// 按 umask 创建（不继承主库权限），故每次 openDb 在 schema 写入后统一补 chmod——
// 侧车只在持库期间存在，重开库时此处必然重新覆盖到
function secureDbFiles() {
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try { chmodSync(f, 0o600); } catch { /* 文件可能不存在 */ }
  }
}

function openDb() {
  db = new DatabaseSync(DB_FILE);
  // WAL：崩溃只丢未 checkpoint 的末尾事务，库体不易坏；读不阻塞写
  // synchronous=NORMAL：WAL 下应用崩溃不丢已提交事务（掉电才可能丢最后一个 commit），
  // 耐久性与原 appendFileSync 相当，写入快一个数量级
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      dir TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      pos INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      cleared_seq INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS blocks (
      conv_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (conv_id, seq)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS attachments (
      name TEXT PRIMARY KEY,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL
    ) WITHOUT ROWID;
  `);
  secureDbFiles();
}

// 通用 kv（appearance / general / modelsCatalog 缓存等单行 JSON）
export function getKv(key) {
  const row = stmt("kv.get", "SELECT data FROM kv WHERE key = ?").get(key);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

export function setKv(key, value) {
  stmt(
    "kv.set",
    "INSERT INTO kv (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  ).run(key, JSON.stringify(value), Date.now());
}

// ---------- 启动重放 ----------

function replayConversations() {
  conversations = {};
  for (const m of stmt("conv.all", "SELECT * FROM conversations").all()) {
    conversations[m.id] = {
      projectDir: m.project_dir,
      title: m.title,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
      blocks: null, // 懒加载：首次访问才读 blocks 表（见 ensureBlocks）
      _loaded: false,
      _hiSeq: 0,
      _clearedSeq: m.cleared_seq,
    };
  }
}

export function load() {
  mkdirSync(DIR, { recursive: true });
  if (db) { safe("close", () => db.close()); db = null; for (const k in stmts) delete stmts[k]; }
  openDb();

  // 最新添加的项目在前（added_at 倒序）
  projects = stmt("proj.all", "SELECT dir FROM projects ORDER BY added_at DESC, dir").all()
    .map((r) => ({ dir: r.dir }));

  replayConversations();

  providers = stmt("prov.all", "SELECT data FROM providers ORDER BY pos").all()
    .map((r) => { try { return JSON.parse(r.data); } catch { return null; } })
    .filter(Boolean);
  appearance = getKv("appearance");
  general = getKv("general");

  // 内置供应商种子：缺失时补齐（deepseek 置顶、grok 压尾，与原 JSONL 一致）
  safe("seed", () => {
    if (!providers.some((p) => p.id === "deepseek")) {
      const min = stmt("prov.minPos", "SELECT MIN(pos) AS p FROM providers").get().p;
      stmt("prov.ins", "INSERT INTO providers (id, pos, data, updated_at) VALUES (?, ?, ?, ?)")
        .run("deepseek", (min ?? 1) - 1, JSON.stringify(DEFAULT_PROVIDER), Date.now());
      providers.unshift({ ...DEFAULT_PROVIDER });
    }
    if (!providers.some((p) => p.id === "grok")) {
      const max = stmt("prov.maxPos", "SELECT MAX(pos) AS p FROM providers").get().p;
      stmt("prov.ins", "INSERT INTO providers (id, pos, data, updated_at) VALUES (?, ?, ?, ?)")
        .run("grok", (max ?? -1) + 1, JSON.stringify(DEFAULT_GROK_PROVIDER), Date.now());
      providers.push({ ...DEFAULT_GROK_PROVIDER });
    }
  });

  return { projects, conversations };
}

// ---------- 外观 / 通用设置 ----------

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
  safe("setAppearance", () => setKv("appearance", appearance));
}

export function getGeneral() {
  return { ...DEFAULT_GENERAL, ...(general ?? {}) };
}

export function setGeneral(patch) {
  general = { ...getGeneral(), ...(patch ?? {}) };
  safe("setGeneral", () => setKv("general", general));
}

// ---------- 供应商 ----------

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

// 单行写穿：UPDATE 覆盖旧值（含旧密文），不存在整文件重写，历史行残留问题消失
function persistProvider(p) {
  stmt(
    "prov.set",
    "INSERT INTO providers (id, pos, data, updated_at) VALUES (?, (SELECT COALESCE(MAX(pos), -1) + 1 FROM providers), ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  ).run(p.id, JSON.stringify(p), Date.now());
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
  safe("upsertProvider", () => persistProvider(clean));
}

/** 模型目录自动同步专用：整表替换指定供应商的 models，有实际差异才落盘。
 *  返回是否发生了变更。仅内置供应商由 model-catalog.js 调用。 */
export function updateProviderModels(id, models) {
  const p = providers.find((x) => x.id === id);
  if (!p) return false;
  if (JSON.stringify(p.models) === JSON.stringify(models)) return false;
  p.models = models;
  safe("updateProviderModels", () => persistProvider(p));
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
  // 凭据变更与换 key 同级敏感：单行覆盖写，旧凭据随旧行值一起消失
  safe("setProviderOAuth", () => persistProvider(p));
}

export function clearProviderOAuth(id) {
  setProviderOAuth(id, null);
}

export function deleteProvider(id) {
  const p = providers.find((x) => x.id === id);
  if (!p || p.builtin) return; // 内置供应商不可删
  providers = providers.filter((x) => x.id !== id);
  safe("deleteProvider", () => stmt("prov.del", "DELETE FROM providers WHERE id = ?").run(id));
}

// ---------- 项目 ----------

export function addProject(dir) {
  if (!projects.some((p) => p.dir === dir)) {
    projects.unshift({ dir }); // 最新添加置顶
    safe("addProject", () =>
      stmt("proj.add", "INSERT OR IGNORE INTO projects (dir, added_at) VALUES (?, ?)").run(dir, Date.now())
    );
  }
}

// ---------- 会话 ----------

function touchConversation(c, ts = Date.now()) {
  c.updatedAt = ts;
  return ts;
}

export function newConversation(projectDir) {
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const createdAt = Date.now();
  conversations[id] = {
    projectDir, title: "新对话", createdAt, updatedAt: createdAt,
    blocks: [], _loaded: true, _hiSeq: 0, _clearedSeq: 0,
  };
  safe("newConversation", () =>
    stmt(
      "conv.ins",
      "INSERT INTO conversations (id, project_dir, title, created_at, updated_at, cleared_seq) VALUES (?, ?, ?, ?, ?, 0)"
    ).run(id, projectDir, "新对话", createdAt, createdAt)
  );
  return id;
}

// 首次访问某会话时才从 blocks 表重放：启动只读 meta，大历史库不再拖慢冷启动
function ensureBlocks(id) {
  const c = conversations[id];
  if (!c || c._loaded) return c ?? null;
  c._hiSeq = stmt("blk.max", "SELECT COALESCE(MAX(seq), 0) AS s FROM blocks WHERE conv_id = ?").get(id).s;
  c.blocks = stmt("blk.all", "SELECT data FROM blocks WHERE conv_id = ? AND seq > ? ORDER BY seq").all(id, c._clearedSeq)
    .map((r) => { try { return JSON.parse(r.data); } catch { return null; } })
    .filter(Boolean);
  c._loaded = true;
  return c;
}

export function getConversation(id) {
  return ensureBlocks(id);
}

export function setTitle(id, title) {
  const c = conversations[id];
  if (c && c.title === "新对话") {
    c.title = title;
    const ts = touchConversation(c);
    safe("setTitle", () =>
      stmt("conv.title", "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, ts, id)
    );
    return true;
  }
  return false;
}

export function appendBlock(id, block) {
  const c = ensureBlocks(id);
  if (c) {
    c.blocks.push(block);
    const ts = touchConversation(c);
    const row = { ...block, ts };
    safe("appendBlock", () => {
      db.exec("BEGIN");
      try {
        stmt("blk.ins", "INSERT INTO blocks (conv_id, seq, ts, data) VALUES (?, ?, ?, ?)")
          .run(id, ++c._hiSeq, ts, JSON.stringify(row));
        stmt("conv.touch", "UPDATE conversations SET updated_at = ? WHERE id = ?").run(ts, id);
        db.exec("COMMIT");
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* noop */ }
        throw err;
      }
    });
  }
}

export function clearBlocks(id) {
  const c = ensureBlocks(id);
  if (c) {
    c.blocks = [];
    const ts = touchConversation(c);
    // 与原 JSONL 的 clear 事件同语义：旧 blocks 行保留（考古可见），
    // 重放水位 cleared_seq 推进到当前最大 seq，之后只读水位之后的块
    c._clearedSeq = c._hiSeq;
    safe("clearBlocks", () =>
      stmt("conv.clear", "UPDATE conversations SET cleared_seq = ?, updated_at = ? WHERE id = ?").run(c._clearedSeq, ts, id)
    );
  }
}

export function sidebarData() {
  const convs = Object.entries(conversations).map(([id, c]) => ({
    id,
    title: c.title,
    projectDir: c.projectDir,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt ?? c.createdAt,
  }));
  // 最近有内容/改动的对话靠前；新建对话 updatedAt=createdAt，自然置顶
  convs.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  return {
    projects: projects.map((p) => ({
      dir: p.dir,
      name: basename(p.dir),
      conversations: convs.filter((c) => c.projectDir === p.dir),
    })),
  };
}

// ---------- 附件（BLOB 入库；展示走 xatt://，发送时按名取回） ----------

export function saveAttachment(name, buf) {
  safe("saveAttachment", () =>
    stmt("att.ins", "INSERT INTO attachments (name, data, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data, created_at = excluded.created_at")
      .run(name, buf, Date.now())
  );
}

// 返回 { data: Uint8Array } | null（Uint8Array 可直接喂 Response / Buffer.from）
export function getAttachment(name) {
  const row = stmt("att.get", "SELECT data FROM attachments WHERE name = ?").get(name);
  return row ? { data: row.data } : null;
}
