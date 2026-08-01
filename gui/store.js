// 持久化：JSONL（append-only 事件日志）
//   ~/.xharness/gui/projects.jsonl        —— 每行 {op:"add"|"remove", dir, ts}
//   ~/.xharness/gui/sessions/<id>.jsonl   —— 首行 {kind:"meta",...}；此后每行一个 block；
//                                            标题/置顶经 {kind:"meta_update"} 行；/clear 经 {kind:"clear"} 行
// 全部只追加不重写；启动时重放重建内存态。旧 state.json 自动迁移。
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync,
  readdirSync, existsSync, renameSync, rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const DIR = join(homedir(), ".xharness", "gui");
const SESS_DIR = join(DIR, "sessions");
const PROJECTS_FILE = join(DIR, "projects.jsonl");
const SETTINGS_FILE = join(DIR, "settings.jsonl");
const LEGACY_FILE = join(DIR, "state.json");

let projects = []; // [{dir}]
let conversations = {}; // id -> {projectDir,title,pinned,createdAt,blocks}
let providers = []; // 模型供应商（settings.jsonl 重放）

const DEFAULT_PROVIDER = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic",
  apiFormat: "anthropic",
  keyMode: "env", // env: 用 ANTHROPIC_API_KEY / DEEPSEEK_API_KEY；manual: 手填
  apiKey: "",
  enabled: true,
  builtin: true,
  models: [
    { id: "deepseek-v4-pro", contextWindow: 1_000_000 },
    { id: "deepseek-v4-flash", contextWindow: 1_000_000 },
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

function migrateLegacy() {
  if (!existsSync(LEGACY_FILE)) return;
  try {
    const legacy = JSON.parse(readFileSync(LEGACY_FILE, "utf8"));
    for (const p of legacy.projects ?? []) {
      appendLine(PROJECTS_FILE, { op: "add", dir: p.dir, ts: Date.now() });
    }
    for (const [id, c] of Object.entries(legacy.conversations ?? {})) {
      if (existsSync(sessFile(id))) continue;
      let out = line({
        kind: "meta", id, projectDir: c.projectDir,
        title: c.title, createdAt: c.createdAt ?? Date.now(),
      });
      if (c.pinned) out += line({ kind: "meta_update", pinned: true, ts: Date.now() });
      for (const b of c.blocks ?? []) out += line(b);
      writeFileSync(sessFile(id), out);
    }
    renameSync(LEGACY_FILE, LEGACY_FILE + ".bak");
    console.log("store: 已迁移旧 state.json 至 JSONL");
  } catch (err) {
    console.error("store: 旧数据迁移失败:", err.message);
  }
}

export function load() {
  mkdirSync(SESS_DIR, { recursive: true });
  migrateLegacy();

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

  // settings.jsonl 重放：{op:"upsert",provider} / {op:"delete",id}
  providers = [];
  for (const r of readLines(SETTINGS_FILE)) {
    if (r.op === "upsert" && r.provider?.id) {
      const i = providers.findIndex((p) => p.id === r.provider.id);
      if (i >= 0) providers[i] = r.provider;
      else providers.push(r.provider);
    } else if (r.op === "delete") {
      providers = providers.filter((p) => p.id !== r.id);
    }
  }
  if (!providers.some((p) => p.id === "deepseek")) {
    providers.unshift({ ...DEFAULT_PROVIDER });
    appendLine(SETTINGS_FILE, { op: "upsert", provider: DEFAULT_PROVIDER, ts: Date.now() });
  }

  return { projects, conversations };
}

export function getProviders() {
  return providers;
}

export function upsertProvider(p) {
  const i = providers.findIndex((x) => x.id === p.id);
  if (i >= 0) providers[i] = p;
  else providers.push(p);
  appendLine(SETTINGS_FILE, { op: "upsert", provider: p, ts: Date.now() });
}

export function deleteProvider(id) {
  const p = providers.find((x) => x.id === id);
  if (!p || p.builtin) return; // 内置供应商不可删
  providers = providers.filter((x) => x.id !== id);
  appendLine(SETTINGS_FILE, { op: "delete", id, ts: Date.now() });
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
