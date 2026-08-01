// 持久化：~/.xharness/gui/state.json
// projects: [{dir}]；conversations: {id: {projectDir,title,pinned,createdAt,blocks}}
// blocks 是渲染态记录（user/assistant/tool/notice），重开会话时用于展示与种子历史。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const DIR = join(homedir(), ".xharness", "gui");
const FILE = join(DIR, "state.json");

let state = { projects: [], conversations: {} };

export function load() {
  try {
    state = JSON.parse(readFileSync(FILE, "utf8"));
    if (!state.projects) state.projects = [];
    if (!state.conversations) state.conversations = {};
  } catch {
    state = { projects: [], conversations: {} };
  }
  return state;
}

let saveTimer = null;
export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error("store save failed:", err.message);
    }
  }, 300);
}

export function addProject(dir) {
  if (!state.projects.some((p) => p.dir === dir)) {
    state.projects.push({ dir });
    save();
  }
}

export function newConversation(projectDir) {
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  state.conversations[id] = {
    projectDir,
    title: "新对话",
    pinned: false,
    createdAt: Date.now(),
    blocks: [],
  };
  save();
  return id;
}

export function getConversation(id) {
  return state.conversations[id] ?? null;
}

export function setTitle(id, title) {
  const c = state.conversations[id];
  if (c && c.title === "新对话") {
    c.title = title;
    save();
    return true;
  }
  return false;
}

export function setPinned(id, pinned) {
  const c = state.conversations[id];
  if (c) {
    c.pinned = pinned;
    save();
  }
}

export function deleteConversation(id) {
  delete state.conversations[id];
  save();
}

export function appendBlock(id, block) {
  const c = state.conversations[id];
  if (c) {
    c.blocks.push(block);
    save();
  }
}

export function replaceLastBlock(id, block) {
  const c = state.conversations[id];
  if (c && c.blocks.length > 0) {
    c.blocks[c.blocks.length - 1] = block;
    save();
  }
}

export function clearBlocks(id) {
  const c = state.conversations[id];
  if (c) {
    c.blocks = [];
    save();
  }
}

export function sidebarData() {
  const convs = Object.entries(state.conversations).map(([id, c]) => ({
    id,
    title: c.title,
    pinned: !!c.pinned,
    projectDir: c.projectDir,
    createdAt: c.createdAt,
  }));
  convs.sort((a, b) => a.createdAt - b.createdAt);
  return {
    pinned: convs.filter((c) => c.pinned),
    projects: state.projects.map((p) => ({
      dir: p.dir,
      name: basename(p.dir),
      conversations: convs.filter((c) => c.projectDir === p.dir),
    })),
  };
}
